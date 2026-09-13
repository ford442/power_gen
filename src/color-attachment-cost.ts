// ============================================================================
// Color-attachment byte budget (WebGPU `maxColorAttachmentBytesPerSample`)
// ============================================================================
// Pure, GPU-free module so `npm run check:post` can import it on plain Node
// (webgpu-manager.ts pulls in pipeline layouts that touch GPUShaderStage at
// module scope, which does not exist outside a browser).

/**
 * WebGPU's guaranteed default for `maxColorAttachmentBytesPerSample`. A device
 * always supports at least this much, so only a scene pass that needs *more*
 * has anything to negotiate.
 */
export const DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE = 32;

/**
 * Render-target byte cost / alignment per color format (WebGPU spec,
 * "Color Attachment Bytes Per Sample"). Only the formats this app ever
 * attaches are listed; an unknown format is treated as the 16-byte worst case
 * so a new target can never silently under-report.
 */
const COLOR_ATTACHMENT_BYTE_COST: Record<string, { bytes: number; align: number }> = {
  r8unorm: { bytes: 1, align: 1 },
  r8snorm: { bytes: 1, align: 1 },
  r8uint: { bytes: 1, align: 1 },
  r8sint: { bytes: 1, align: 1 },
  r16uint: { bytes: 2, align: 2 },
  r16sint: { bytes: 2, align: 2 },
  r16float: { bytes: 2, align: 2 },
  rg8unorm: { bytes: 2, align: 2 },
  rg8snorm: { bytes: 2, align: 2 },
  rg8uint: { bytes: 2, align: 2 },
  rg8sint: { bytes: 2, align: 2 },
  r32uint: { bytes: 4, align: 4 },
  r32sint: { bytes: 4, align: 4 },
  r32float: { bytes: 4, align: 4 },
  rg16uint: { bytes: 4, align: 4 },
  rg16sint: { bytes: 4, align: 4 },
  rg16float: { bytes: 4, align: 4 },
  rgba8unorm: { bytes: 4, align: 4 },
  'rgba8unorm-srgb': { bytes: 4, align: 4 },
  rgba8snorm: { bytes: 4, align: 4 },
  rgba8uint: { bytes: 4, align: 4 },
  rgba8sint: { bytes: 4, align: 4 },
  bgra8unorm: { bytes: 4, align: 4 },
  'bgra8unorm-srgb': { bytes: 4, align: 4 },
  rgb10a2uint: { bytes: 8, align: 4 },
  rgb10a2unorm: { bytes: 8, align: 4 },
  rg11b10ufloat: { bytes: 8, align: 4 },
  rg32uint: { bytes: 8, align: 8 },
  rg32sint: { bytes: 8, align: 8 },
  rg32float: { bytes: 8, align: 8 },
  rgba16uint: { bytes: 8, align: 8 },
  rgba16sint: { bytes: 8, align: 8 },
  rgba16float: { bytes: 8, align: 8 },
  rgba32uint: { bytes: 16, align: 16 },
  rgba32sint: { bytes: 16, align: 16 },
  rgba32float: { bytes: 16, align: 16 }
};

/**
 * Bytes-per-sample a render pass with `formats` as its color attachments costs.
 *
 * Per spec each attachment is aligned up before its cost is added, so the
 * order of the targets matters — pass them exactly as the pipeline declares
 * them. This is a *per-sample* figure: 4x MSAA does not multiply it.
 */
export function colorAttachmentBytesPerSample(formats: ReadonlyArray<GPUTextureFormat | null>): number {
  let total = 0;
  for (const format of formats) {
    if (!format) continue; // a `null` target in a pipeline costs nothing
    const cost = COLOR_ATTACHMENT_BYTE_COST[format] ?? { bytes: 16, align: 16 };
    total = Math.ceil(total / cost.align) * cost.align + cost.bytes;
  }
  return total;
}
