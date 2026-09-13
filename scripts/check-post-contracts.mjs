#!/usr/bin/env node
/**
 * check-post-contracts.mjs — assert the CPU↔WGSL contracts of the post stack.
 *
 * These are the couplings that silently corrupt a frame rather than failing
 * loudly: a uniform packed as N floats read as a struct of M fields, or the
 * IBL bake disagreeing with the shader that samples it. naga cannot see any of
 * them, because both sides are individually valid.
 *
 * Checks:
 *   1. IBL_TEX_SIZE / IBL_SPEC_LEVELS match between ibl-prefilter.ts and
 *      pbr-eval.wgsl (also enforced at runtime by assertIblShaderContract).
 *   2. Every BloomParams copy has the same field count as packPostUniforms
 *      emits, and the uniform buffer is allocated for exactly that many floats.
 *   3. The SsrParams block size in scene-setup.ts matches ssr-compute.wgsl.
 *   4. Every attachable color format is priced, and the scene pass's
 *      bytes-per-sample either fits the default limit or is negotiated.
 *
 * Usage: node scripts/check-post-contracts.mjs   (exit 1 on drift)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Transpile a .ts module (via the esbuild Vite already depends on) and import it directly — no ts-node/tsx dep, works on plain Node. */
async function importTs(rel) {
  const { code } = await esbuild.transform(read(rel), { loader: 'ts', format: 'esm' });
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
}

const failures = [];
const ok = [];

function check(label, condition, detail) {
  if (condition) ok.push(label);
  else failures.push(`${label}: ${detail}`);
}

// ── 1. IBL bake ↔ pbr-eval.wgsl ─────────────────────────────────────────────
{
  const { assertIblShaderContract, IBL_TEX_SIZE, IBL_SPEC_LEVELS, IBL_LAYERS } =
    await importTs('src/ibl-prefilter.ts');
  try {
    assertIblShaderContract(read('src/shaders/common/pbr-eval.wgsl'));
    ok.push(`IBL contract: ${IBL_TEX_SIZE}² × ${IBL_LAYERS} layers (${IBL_SPEC_LEVELS} GGX + irradiance)`);
  } catch (e) {
    failures.push(String(e.message || e));
  }
}

// ── 2. BloomParams ↔ packPostUniforms ───────────────────────────────────────
{
  const { packPostUniforms, getLightingPreset } =
    await importTs('src/seg-lighting-presets.ts');
  const packed = packPostUniforms({ preset: getLightingPreset('studio') }).length;

  const sources = {
    'common/bloom-params.wgsl': read('src/shaders/common/bloom-params.wgsl')
  };
  for (const [name, src] of Object.entries(sources)) {
    const blocks = [...src.matchAll(/struct BloomParams \{([\s\S]*?)\n\s*\}/g)];
    check(`${name}: has BloomParams`, blocks.length > 0, 'no struct BloomParams found');
    blocks.forEach((m, i) => {
      const fields = [...m[1].matchAll(/^\s*\w+\s*:\s*f32\s*,/gm)].length;
      check(
        `${name}[${i}]: ${fields} BloomParams fields`,
        fields === packed,
        `${fields} fields but packPostUniforms emits ${packed} floats`
      );
    });
  }

  const sceneSetup = read('src/visualizer/scene-setup.ts');
  const bloomBuf = /bloom-params'[\s\S]{0,120}?size:\s*(\d+)/.exec(sceneSetup);
  check(
    `bloomParamsBuffer sized for ${packed} floats`,
    bloomBuf && Number(bloomBuf[1]) === packed * 4,
    `buffer is ${bloomBuf ? bloomBuf[1] : '?'} B, expected ${packed * 4} B`
  );
}

// ── 3. SsrParams ↔ ssr-compute.wgsl ─────────────────────────────────────────
{
  const wgsl = read('src/shaders/passes/ssr-compute.wgsl');
  const block = /struct SsrParams \{([\s\S]*?)\n\}/.exec(wgsl);
  check('ssr-compute.wgsl: has SsrParams', !!block, 'no struct SsrParams found');
  if (block) {
    const body = block[1];
    const mats = [...body.matchAll(/:\s*mat4x4f\s*,/g)].length;
    const vecs = [...body.matchAll(/:\s*vec2f\s*,/g)].length;
    const scalars = [...body.matchAll(/:\s*f32\s*,/g)].length;
    const bytes = mats * 64 + vecs * 8 + scalars * 4;

    const declared = /SSR_PARAMS_BYTES = (\d+)/.exec(read('src/visualizer/scene-setup.ts'));
    check(
      `SsrParams is ${bytes} B (${mats} mat4 + ${vecs} vec2 + ${scalars} f32)`,
      declared && Number(declared[1]) === bytes,
      `scene-setup.ts declares ${declared ? declared[1] : '?'} B`
    );
    check('SsrParams is 16-byte aligned', bytes % 16 === 0, `${bytes} B is not a multiple of 16`);
  }
}

// ── 4. Scene color attachments ↔ maxColorAttachmentBytesPerSample ───────────
{
  const { colorAttachmentBytesPerSample, DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE: DEFAULT_BPS } =
    await importTs('src/color-attachment-cost.ts');

  const helpers = read('src/pipeline-layout/helpers.ts');
  const gbuf = /MATERIAL_GBUFFER_FORMAT:\s*GPUTextureFormat\s*=\s*'([\w-]+)'/.exec(helpers);
  check('helpers.ts: MATERIAL_GBUFFER_FORMAT found', !!gbuf, 'could not parse the G-buffer format');

  // Every format that can land on a color target must be priced explicitly;
  // an unlisted one silently falls back to the 16-byte worst case.
  const manager = read('src/webgpu-manager.ts');
  const bloomFmt = /BLOOM_HDR_FORMAT:\s*GPUTextureFormat\s*=\s*'([\w-]+)'/.exec(manager);
  const attachable = [
    'bgra8unorm', 'rgba8unorm',            // getPreferredCanvasFormat() candidates
    gbuf ? gbuf[1] : null,                 // metalness/roughness G-buffer
    bloomFmt ? bloomFmt[1] : null          // bloom extract/blur intermediates
  ].filter(Boolean);
  const table = read('src/color-attachment-cost.ts');
  for (const fmt of attachable) {
    check(
      `byte cost priced for ${fmt}`,
      new RegExp(`(^|[{\\s])'?${fmt}'?\\s*:\\s*\\{\\s*bytes:`, 'm').test(table),
      'missing from COLOR_ATTACHMENT_BYTE_COST (would fall back to the 16 B worst case)'
    );
  }

  // The scene pass declares [canvasFormat, MATERIAL_GBUFFER_FORMAT] (ADR-0005
  // WS2). Its cost must either fit the guaranteed default or be requested.
  if (gbuf) {
    const need = Math.max(
      colorAttachmentBytesPerSample(['bgra8unorm', gbuf[1]]),
      colorAttachmentBytesPerSample(['rgba8unorm', gbuf[1]])
    );
    const requests = /sceneColorAttachmentLimit[\s\S]*?maxColorAttachmentBytesPerSample/.test(manager);
    check(
      `scene pass costs ${need} B/sample (default ${DEFAULT_BPS} B)`,
      need <= DEFAULT_BPS || requests,
      `exceeds the default and webgpu-manager.ts does not request the limit`
    );
  }

  // Guard the alignment arithmetic itself against an accidental rewrite.
  check(
    'bytes-per-sample aligns before adding',
    colorAttachmentBytesPerSample(['rgba8unorm', 'rgba16float']) === 16,
    `expected 16 (4 → align 8 → +8), got ${colorAttachmentBytesPerSample(['rgba8unorm', 'rgba16float'])}`
  );
  check(
    'null targets are free',
    colorAttachmentBytesPerSample(['rg8unorm', null]) === 2,
    `expected 2, got ${colorAttachmentBytesPerSample(['rg8unorm', null])}`
  );
}

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  console.error('\n[check-post-contracts] FAILED:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`[check-post-contracts] ${ok.length} contracts ok`);
