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
 *   1. IBL_TEX_SIZE / IBL_SPEC_LEVELS match between ibl-prefilter.js and
 *      pbr-eval.wgsl (also enforced at runtime by assertIblShaderContract).
 *   2. Every BloomParams copy has the same field count as packPostUniforms
 *      emits, and the uniform buffer is allocated for exactly that many floats.
 *   3. The SsrParams block size in scene-setup.js matches ssr-compute.wgsl.
 *
 * Usage: node scripts/check-post-contracts.mjs   (exit 1 on drift)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const failures = [];
const ok = [];

function check(label, condition, detail) {
  if (condition) ok.push(label);
  else failures.push(`${label}: ${detail}`);
}

// ── 1. IBL bake ↔ pbr-eval.wgsl ─────────────────────────────────────────────
{
  const { assertIblShaderContract, IBL_TEX_SIZE, IBL_SPEC_LEVELS, IBL_LAYERS } =
    await import(new URL('../src/ibl-prefilter.js', import.meta.url));
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
    await import(new URL('../src/seg-lighting-presets.js', import.meta.url));
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
      `scene-setup.js declares ${declared ? declared[1] : '?'} B`
    );
    check('SsrParams is 16-byte aligned', bytes % 16 === 0, `${bytes} B is not a multiple of 16`);
  }
}

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  console.error('\n[check-post-contracts] FAILED:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`[check-post-contracts] ${ok.length} contracts ok`);
