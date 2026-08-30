export const VS = GPUShaderStage.VERTEX;
export const FS = GPUShaderStage.FRAGMENT;
export const CS = GPUShaderStage.COMPUTE;
export const VF = VS | FS;

export function uniform(binding: number, visibility: number): GPUBindGroupLayoutEntry {
  return { binding, visibility, buffer: { type: 'uniform' } };
}

export function storage(binding: number, visibility: number, readOnly = false): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility,
    buffer: { type: readOnly ? 'read-only-storage' : 'storage' }
  };
}

export function texture(
  binding: number,
  visibility: number,
  sampleType: GPUTextureSampleType = 'float'
): GPUBindGroupLayoutEntry {
  return { binding, visibility, texture: { sampleType, viewDimension: '2d' } };
}

export function depthTexture(binding: number, visibility: number): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility,
    texture: { sampleType: 'depth', viewDimension: '2d' }
  };
}

/** Multisampled depth binding (`texture_depth_multisampled_2d`) — the depth-resolve pass reads this. */
export function depthTextureMultisampled(binding: number, visibility: number): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility,
    texture: { sampleType: 'depth', viewDimension: '2d', multisampled: true }
  };
}

export function textureArray(
  binding: number,
  visibility: number,
  sampleType: GPUTextureSampleType = 'float'
): GPUBindGroupLayoutEntry {
  return { binding, visibility, texture: { sampleType, viewDimension: '2d-array' } };
}

export function storageTexture(
  binding: number,
  visibility: number,
  format: GPUTextureFormat
): GPUBindGroupLayoutEntry {
  return { binding, visibility, storageTexture: { access: 'write-only', format, viewDimension: '2d' } };
}

export function sampler(binding: number, visibility: number): GPUBindGroupLayoutEntry {
  return { binding, visibility, sampler: { type: 'filtering' } };
}

export const VB_POS_NORMAL: GPUVertexBufferLayout = {
  arrayStride: 24,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' }
  ]
};

export const VB_POS_NORMAL_UV: GPUVertexBufferLayout = {
  arrayStride: 32,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32x2' }
  ]
};

export const VB_ENERGY_ARC: GPUVertexBufferLayout = {
  arrayStride: 32,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
    { shaderLocation: 2, offset: 24, format: 'float32' },
    { shaderLocation: 3, offset: 28, format: 'float32' }
  ]
};

export const VB_GRID: GPUVertexBufferLayout = {
  arrayStride: 8,
  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }]
};

export const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
};

export const ADDITIVE_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
};

export const ADDITIVE_SRC_ALPHA: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
};

export const SSR_FORMAT: GPUTextureFormat = 'rgba16float';

/** Metalness (r) / roughness (g) G-buffer packed into the scene render pass's second color target. */
export const MATERIAL_GBUFFER_FORMAT: GPUTextureFormat = 'rg8unorm';

export function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}
