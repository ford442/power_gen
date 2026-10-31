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
 *   3. The SsrParams block size in scene-post-buffers.ts matches ssr-compute.wgsl.
 *   4. TaaParams matches taa-resolve.wgsl, is packed at the offsets the
 *      render loop writes, and is gated off below high/ultra + focus.
 *   5. The IBL compute prefilter's uniform block, dispatch schedule,
 *      workgroup size and environment constants match ibl-prefilter.ts.
 *   6. Every attachable color format is priced, and the scene pass's
 *      bytes-per-sample either fits the default limit or is negotiated.
 *   7. Colour pipeline (#223): resolveColorTargets picks a float scene and an
 *      -srgb output on the linear path, a float canvas for ?hdr=1, the canvas
 *      format everywhere on ?color=legacy; BloomParams' output fields sit
 *      where packPostUniforms writes them; BloomLevel matches bloom-chain.ts.
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
/** Bundled, so a module may import LabConfig (or anything else) like the app does. */
async function importTs(rel) {
  const result = await esbuild.build({
    entryPoints: [join(ROOT, rel)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    write: false,
    logLevel: 'silent',
    plugins: [{
      name: 'vite-raw-stub',
      setup(b) {
        b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: a.path, namespace: 'raw-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
      }
    }]
  });
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);
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

  const scenePostBuffers = read('src/visualizer/scene-post-buffers.ts');
  const bloomBuf = /bloom-params'[\s\S]{0,120}?size:\s*(\d+)/.exec(scenePostBuffers);
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

    const declared = /SSR_PARAMS_BYTES = (\d+)/.exec(read('src/visualizer/scene-post-buffers.ts'));
    check(
      `SsrParams is ${bytes} B (${mats} mat4 + ${vecs} vec2 + ${scalars} f32)`,
      declared && Number(declared[1]) === bytes,
      `scene-post-buffers.ts declares ${declared ? declared[1] : '?'} B`
    );
    check('SsrParams is 16-byte aligned', bytes % 16 === 0, `${bytes} B is not a multiple of 16`);
  }
}

// ── 4. TaaParams ↔ taa-resolve.wgsl ─────────────────────────────────────────
{
  const wgsl = read('src/shaders/passes/taa-resolve.wgsl');
  const block = /struct TaaParams \{([\s\S]*?)\n\}/.exec(wgsl);
  check('taa-resolve.wgsl: has TaaParams', !!block, 'no struct TaaParams found');
  if (block) {
    const body = block[1];
    const mats = [...body.matchAll(/:\s*mat4x4f\s*,/g)].length;
    const vecs = [...body.matchAll(/:\s*vec2f\s*,/g)].length;
    const scalars = [...body.matchAll(/:\s*f32\s*,/g)].length;
    const bytes = mats * 64 + vecs * 8 + scalars * 4;

    const declared = /TAA_PARAMS_BYTES = (\d+)/.exec(read('src/visualizer/scene-post-buffers.ts'));
    check(
      `TaaParams is ${bytes} B (${mats} mat4 + ${vecs} vec2 + ${scalars} f32)`,
      declared && Number(declared[1]) === bytes,
      `scene-post-buffers.ts declares ${declared ? declared[1] : '?'} B`
    );
    check('TaaParams is 16-byte aligned', bytes % 16 === 0, `${bytes} B is not a multiple of 16`);

    // The render loop fills the block by float index; the scalars must start
    // where the two matrices end or alpha/historyValid land in texelSize.
    const loop = read('src/visualizer/render-encode.ts');
    check(
      'TAA scalars are packed after both matrices',
      /params\.set\(invViewProj, 0\)/.test(loop)
        && /params\.set\(prevViewProj \?\? viewProj, 16\)/.test(loop)
        && /params\[32\]/.test(loop) && /params\[35\]/.test(loop),
      'render-encode.ts does not pack TaaParams at the expected float offsets'
    );
  }

  // TAA must be gated off wherever ADR-0005 WS2 says it is. Read the table
  // from source: post-processing-config.ts re-exports seg-lighting-presets,
  // which a data: URL import cannot resolve.
  const config = read('src/post-processing-config.ts');
  const gateFor = (tier) => {
    const m = new RegExp(`\\n  ${tier}: \\{([\\s\\S]*?)\\n  \\}`).exec(config);
    if (!m) return null;
    const t = /taa:\s*(\d+)/.exec(m[1]);
    return t ? Number(t[1]) : null;
  };
  for (const tier of ['medium', 'low', 'critical']) {
    check(`taa off at ${tier} tier`, gateFor(tier) === 0, `gate is ${gateFor(tier)}`);
  }
  for (const tier of ['high', 'ultra']) {
    check(`taa on at ${tier} tier`, gateFor(tier) === 1, `gate is ${gateFor(tier)}`);
  }
  const loop = read('src/visualizer/render-encode.ts');
  check(
    'TAA gate also requires focus mode and ?taa',
    /gates\?\.taa[\s\S]{0,200}?!this\.isOverviewMode\(\)[\s\S]{0,200}?this\.taaEnabled !== false/.test(loop),
    'render-encode.ts gate does not check overview mode and the ?taa kill switch'
  );
}

// ── 5. IBL compute prefilter ↔ ibl-prefilter.ts ─────────────────────────────
{
  const {
    IBL_PREFILTER_PARAMS_FLOATS, IBL_LAYERS, IBL_SPEC_LEVELS,
    iblPrefilterJobs, packIblPrefilterParams
  } = await importTs('src/ibl-prefilter.ts');
  const { getLightingPreset } = await importTs('src/seg-lighting-presets.ts');
  const wgsl = read('src/shaders/passes/ibl-prefilter-compute.wgsl');
  const ts = read('src/ibl-prefilter.ts');

  // 4a. IblPrefilterParams block size ↔ the WGSL struct.
  const block = /struct IblPrefilterParams \{([\s\S]*?)\n\}/.exec(wgsl);
  check('ibl-prefilter-compute.wgsl: has IblPrefilterParams', !!block, 'struct not found');
  if (block) {
    const vec4s = [...block[1].matchAll(/:\s*vec4f\s*,/g)].length;
    check(
      `IblPrefilterParams is ${vec4s} × vec4f (${vec4s * 4} floats)`,
      vec4s * 4 === IBL_PREFILTER_PARAMS_FLOATS,
      `WGSL has ${vec4s * 4} floats, IBL_PREFILTER_PARAMS_FLOATS is ${IBL_PREFILTER_PARAMS_FLOATS}`
    );
    check(
      'packIblPrefilterParams fills the block',
      packIblPrefilterParams(getLightingPreset('studio'), iblPrefilterJobs()[0]).length
        === IBL_PREFILTER_PARAMS_FLOATS,
      'packed length differs from IBL_PREFILTER_PARAMS_FLOATS'
    );
  }

  // 4b. One dispatch per array layer — no layer left unbaked.
  const jobs = iblPrefilterJobs();
  check(
    `prefilter dispatches ${jobs.length} layers`,
    jobs.length === IBL_LAYERS,
    `${jobs.length} jobs for ${IBL_LAYERS} texture layers`
  );
  check(
    'exactly one irradiance job, last',
    jobs.filter((j) => j.irradiance).length === 1 && jobs[jobs.length - 1].irradiance
      && jobs[jobs.length - 1].layer === IBL_SPEC_LEVELS,
    'the irradiance layer is not the single final job'
  );
  check(
    'job layers are 0..IBL_LAYERS-1 with no gaps',
    jobs.every((j, i) => j.layer === i),
    `layers: ${jobs.map((j) => j.layer).join(',')}`
  );

  // 4c. Workgroup size ↔ the host's dispatch arithmetic.
  const wg = /@workgroup_size\((\d+),\s*(\d+),\s*(\d+)\)/.exec(wgsl);
  const hostWg = /const WORKGROUP = (\d+);/.exec(read('src/ibl-prefilter-gpu.ts'));
  check(
    `prefilter workgroup ${wg ? wg[1] : '?'}×${wg ? wg[2] : '?'}`,
    wg && hostWg && wg[1] === hostWg[1] && wg[2] === hostWg[1],
    `shader ${wg ? `${wg[1]}x${wg[2]}` : '?'} vs host WORKGROUP ${hostWg ? hostWg[1] : '?'}`
  );

  // 4d. The two envRadiance implementations must shape the environment
  //     identically, or the look changes with the bake path. Neither naga nor
  //     tsc can see this: both sides are individually valid.
  const tsEnv = /function envRadiance\([\s\S]*?\n\}/.exec(ts);
  const wgslEnv = /fn envRadiance\(dir: vec3f\) -> vec3f \{[\s\S]*?\n\}/.exec(wgsl);
  check('both envRadiance bodies found', !!tsEnv && !!wgslEnv, 'could not locate one of them');
  if (tsEnv && wgslEnv) {
    // Shaping constants, which is what actually drifts. Loop scaffolding
    // (0 / 3 in the TS channel loops) has no WGSL counterpart, so compare a
    // curated list rather than every literal.
    for (const k of ['0.55', '0.42', '0.28', '3.2', '0.92', '0.94', '0.97',
                     '0.35', '0.65', '0.78', '0.16']) {
      check(
        `envRadiance constant ${k} in both`,
        tsEnv[0].includes(k) && wgslEnv[0].includes(k),
        `TS:${tsEnv[0].includes(k)} WGSL:${wgslEnv[0].includes(k)}`
      );
    }
    // Lobe tuples (cosOuter, cosInner, gain) in call order.
    const tuples = (src) =>
      [...src.matchAll(/addLobe\([^)]*?([\d.]+),\s*([\d.]+),\s*([\d.]+)\)/g)]
        .map((m) => `${parseFloat(m[1])}/${parseFloat(m[2])}/${parseFloat(m[3])}`);
    const tsT = tuples(tsEnv[0]);
    const wgslT = tuples(wgslEnv[0]);
    check(
      `3 softbox lobes match (${tsT.join(' ')})`,
      tsT.length === 3 && wgslT.length === 3 && tsT.every((t, i) => t === wgslT[i]),
      `TS [${tsT.join(' ')}] vs WGSL [${wgslT.join(' ')}]`
    );
  }
}

// ── 6. Scene color attachments ↔ maxColorAttachmentBytesPerSample ───────────
{
  const { colorAttachmentBytesPerSample, DEFAULT_COLOR_ATTACHMENT_BYTES_PER_SAMPLE: DEFAULT_BPS } =
    await importTs('src/color-attachment-cost.ts');

  const helpers = read('src/pipeline-layout/helpers.ts');
  const gbuf = /MATERIAL_GBUFFER_FORMAT:\s*GPUTextureFormat\s*=\s*'([\w-]+)'/.exec(helpers);
  check('helpers.ts: MATERIAL_GBUFFER_FORMAT found', !!gbuf, 'could not parse the G-buffer format');

  // Every format that can land on a color target must be priced explicitly;
  // an unlisted one silently falls back to the 16-byte worst case.
  const attachable = [
    'bgra8unorm', 'rgba8unorm',            // getPreferredCanvasFormat() candidates
    'bgra8unorm-srgb', 'rgba8unorm-srgb',  // linear pipeline's composite view
    'rg11b10ufloat', 'rgba16float',        // linear scene / bloom; HDR canvas
    gbuf ? gbuf[1] : null                  // metalness/roughness G-buffer
  ].filter(Boolean);
  const table = read('src/color-attachment-cost.ts');
  for (const fmt of attachable) {
    check(
      `byte cost priced for ${fmt}`,
      new RegExp(`(^|[{\\s])'?${fmt}'?\\s*:\\s*\\{\\s*bytes:`, 'm').test(table),
      'missing from COLOR_ATTACHMENT_BYTE_COST (would fall back to the 16 B worst case)'
    );
  }

  // The scene pass declares [sceneFormat, MATERIAL_GBUFFER_FORMAT] (ADR-0005
  // WS2). Its cost must either fit the guaranteed default or be requested.
  const manager = read('src/webgpu-init/adapter.ts');
  if (gbuf) {
    const need = Math.max(
      ...['bgra8unorm', 'rgba8unorm', 'rg11b10ufloat', 'rgba16float']
        .map((scene) => colorAttachmentBytesPerSample([scene, gbuf[1]]))
    );
    const requests = /sceneColorAttachmentLimit[\s\S]*?maxColorAttachmentBytesPerSample/.test(manager);
    check(
      `scene pass costs ≤ ${need} B/sample (default ${DEFAULT_BPS} B)`,
      need <= DEFAULT_BPS || requests,
      `exceeds the default and webgpu-init/adapter.ts does not request the limit`
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

// ── 7. Colour pipeline (#223) ───────────────────────────────────────────────
{
  const { resolveColorTargets, postOutputTransfer } = await importTs('src/webgpu-init/color-pipeline.ts');
  const feats = (...names) => new Set(names);
  const rg = 'rg11b10ufloat-renderable';

  const lin = resolveColorTargets({ mode: 'linear', preferredCanvasFormat: 'bgra8unorm', features: feats(rg), hdrRequested: false });
  check('linear: rg11b10ufloat scene when renderable', lin.sceneFormat === 'rg11b10ufloat', lin.sceneFormat);
  check('linear: composite writes the -srgb view', lin.outputFormat === 'bgra8unorm-srgb'
    && lin.canvasViewFormats.includes('bgra8unorm-srgb') && !lin.shaderEncodesOutput,
    JSON.stringify(lin));
  check('linear: outputTransfer 1 (hardware encode)', postOutputTransfer(lin) === 1, String(postOutputTransfer(lin)));

  const lin16 = resolveColorTargets({ mode: 'linear', preferredCanvasFormat: 'rgba8unorm', features: feats(), hdrRequested: false });
  check('linear: rgba16float scene without rg11b10ufloat-renderable',
    lin16.sceneFormat === 'rgba16float' && lin16.bloomFormat === 'rgba16float', lin16.sceneFormat);
  check('linear: rgba8unorm canvas → rgba8unorm-srgb view', lin16.outputFormat === 'rgba8unorm-srgb', lin16.outputFormat);

  const hdr = resolveColorTargets({ mode: 'linear', preferredCanvasFormat: 'bgra8unorm', features: feats(rg), hdrRequested: true });
  check('hdr: rgba16float canvas, extended, shader-encoded',
    hdr.canvasFormat === 'rgba16float' && hdr.outputFormat === 'rgba16float'
      && hdr.hdrOutput && hdr.shaderEncodesOutput && postOutputTransfer(hdr) === 2,
    JSON.stringify(hdr));

  const leg = resolveColorTargets({ mode: 'legacy', preferredCanvasFormat: 'bgra8unorm', features: feats(rg), hdrRequested: true });
  check('legacy: everything in the canvas format, no HDR, no encode',
    leg.sceneFormat === 'bgra8unorm' && leg.outputFormat === 'bgra8unorm' && !leg.hdrOutput
      && postOutputTransfer(leg) === 0 && leg.bloomFormat === 'rg11b10ufloat',
    JSON.stringify(leg));

  // BloomParams field order ↔ the indices packPostUniforms writes.
  const { packPostUniforms, getLightingPreset } = await importTs('src/seg-lighting-presets.ts');
  const fields = [...read('src/shaders/common/bloom-params.wgsl')
    .matchAll(/^\s*(\w+)\s*:\s*f32\s*,/gm)].map((m) => m[1]);
  const packed = packPostUniforms({
    preset: getLightingPreset('studio'), outputLinearHdr: true, bloomChainLevels: 4, outputTransfer: 2
  });
  const at = (name) => packed[fields.indexOf(name)];
  check('BloomParams.outputLinearHdr packed', at('outputLinearHdr') === 1, String(at('outputLinearHdr')));
  check('BloomParams.bloomChainScale = 1 / levels', at('bloomChainScale') === 0.25, String(at('bloomChainScale')));
  check('BloomParams.outputTransfer packed', at('outputTransfer') === 2, String(at('outputTransfer')));
  const legacyPacked = packPostUniforms({ preset: getLightingPreset('studio') });
  check('legacy defaults: chain scale 0, transfer 0',
    legacyPacked[fields.indexOf('bloomChainScale')] === 0 && legacyPacked[fields.indexOf('outputTransfer')] === 0,
    'packPostUniforms defaults changed');

  // BloomLevel ↔ bloom-chain.ts.
  const { BLOOM_LEVEL_FLOATS, BLOOM_LEVEL_STRIDE, bloomChainSizes, packBloomLevel } =
    await importTs('src/visualizer/bloom-chain.ts');
  const lvl = /struct BloomLevel \{([\s\S]*?)\n\}/.exec(read('src/shaders/common/bloom-level.wgsl'));
  check('bloom-level.wgsl: has BloomLevel', !!lvl, 'struct not found');
  if (lvl) {
    const floats = [...lvl[1].matchAll(/:\s*vec2f\s*,/g)].length * 2 + [...lvl[1].matchAll(/:\s*f32\s*,/g)].length;
    check(`BloomLevel is ${floats} floats`, floats === BLOOM_LEVEL_FLOATS && packBloomLevel(
      { width: 4, height: 4 }, { width: 2, height: 2 }).length === BLOOM_LEVEL_FLOATS,
      `WGSL ${floats}, BLOOM_LEVEL_FLOATS ${BLOOM_LEVEL_FLOATS}`);
  }
  check('BloomLevel slots honour the 256 B uniform offset alignment', BLOOM_LEVEL_STRIDE % 256 === 0,
    String(BLOOM_LEVEL_STRIDE));
  const sizes1080 = bloomChainSizes(1920, 1080);
  check(`1080p chain: ${sizes1080.length} levels from ${sizes1080[0].width}×${sizes1080[0].height}`,
    sizes1080.length === 6 && sizes1080[0].width === 960 && sizes1080[0].height === 540,
    JSON.stringify(sizes1080));
  check('tiny canvas still gets one level', bloomChainSizes(3, 3).length === 1, JSON.stringify(bloomChainSizes(3, 3)));
}

for (const line of ok) console.log(`  ok: ${line}`);
if (failures.length) {
  console.error('\n[check-post-contracts] FAILED:');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`[check-post-contracts] ${ok.length} contracts ok`);
