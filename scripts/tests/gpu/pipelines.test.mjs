/**
 * test:pipelines — every production pipeline really compiles (#258 §2).
 *
 * `check:wgsl` proves each module parses in naga. This builds the app's own
 * `PipelineLayoutCache` on a Dawn device (Tint + Dawn validation — what
 * Chrome runs) and calls every `ensure*` factory with the real shader text,
 * the real explicit layouts, the real vertex layouts and the real target
 * formats, for each colour mode × depth format × sample count the app can
 * boot into. A shader/layout mismatch, a wrong vertex stride or a target
 * format the device cannot render fails here instead of on Pages.
 *
 * Also asserted:
 *   - no shader module reports a compile error (warnings are printed);
 *   - every pipeline layout the cache registers is used by a pipeline here,
 *     so a new layout cannot ship without a compile test;
 *   - #171's "never ask for what no pass uses": the device is requested the
 *     way webgpu-manager.ts requests it, every OPTIONAL_DEVICE_FEATURES entry
 *     has a consumer, and every PREFERRED_LIMITS key is exceeded by a
 *     measured need.
 *
 * Skips with a notice when Dawn has no adapter; REQUIRE_GPU=1 (CI) fails.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gpuApp } from '../../lib/gpu-app.mjs';
import { CORE_DEFAULT_LIMITS, captureGpuErrors, gpuSkip, nodeDevice, nodeGpu } from '../../lib/node-gpu.mjs';

const gpu = await nodeGpu();
const skip = gpuSkip(gpu);

const app = skip ? null : await gpuApp();

/**
 * Sessions the app can boot into. `features` is what the device is created
 * with — `null` means "negotiate like the app"; `[]` drops the optional ones
 * (an adapter without `rg11b10ufloat-renderable` → `rgba16float` scene).
 */
const SESSIONS = [
  { name: 'linear, negotiated features (default boot)', mode: 'linear', features: null, canvas: 'bgra8unorm' },
  { name: 'linear, no optional features (rgba16float scene)', mode: 'linear', features: [], canvas: 'bgra8unorm' },
  { name: 'linear, ?hdr=1 (rgba16float canvas)', mode: 'linear', features: null, canvas: 'bgra8unorm', hdr: true },
  { name: 'linear, rgba8unorm canvas (Android)', mode: 'linear', features: null, canvas: 'rgba8unorm' },
  { name: '?color=legacy', mode: 'legacy', features: null, canvas: 'bgra8unorm' }
];

/** SSR off / on — webgpu-init/canvas.ts picks the depth format from it. */
const DEPTH_FORMATS = skip ? [] : [app.resolveDepthFormat(false), app.resolveDepthFormat(true)];

/** Build every pipeline of one session; returns what was created and what broke. */
async function buildSession(session, depthFormat) {
  const requiredFeatures = session.features ?? app.negotiateFeatures(gpu.adapter);
  const colorTargets = app.resolveColorTargets({
    mode: session.mode,
    preferredCanvasFormat: session.canvas,
    features: new Set(requiredFeatures),
    hdrRequested: !!session.hdr
  });
  // Exactly webgpu-manager.ts `_requestDevice`: Dawn then enforces these
  // limits (core defaults where nothing is asked), not the adapter's.
  const requiredLimits = app.negotiateLimits(gpu.adapter, {
    ...app.PREFERRED_LIMITS,
    ...app.sceneColorAttachmentLimit(colorTargets.sceneFormat)
  });
  const device = await nodeDevice(gpu, { requiredFeatures, requiredLimits, label: 'test-pipelines' });

  const rec = { modules: [], pipelines: [], failures: [], ensureFailures: [], bgls: [], layouts: [], usedLayouts: new Set() };
  const wrap = (name, fn) => {
    const orig = device[name].bind(device);
    device[name] = (desc) => fn(orig, desc);
  };
  wrap('createShaderModule', (orig, desc) => {
    const module = orig(desc);
    rec.modules.push({ label: desc.label, module, code: desc.code });
    return module;
  });
  wrap('createBindGroupLayout', (orig, desc) => {
    const layout = orig(desc);
    rec.bgls.push({ label: desc.label, entries: desc.entries, layout });
    return layout;
  });
  wrap('createPipelineLayout', (orig, desc) => {
    const layout = orig(desc);
    rec.layouts.push({ label: desc.label, bgls: desc.bindGroupLayouts, layout });
    return layout;
  });
  for (const kind of ['createRenderPipelineAsync', 'createComputePipelineAsync']) {
    wrap(kind, (orig, desc) => {
      rec.pipelines.push({ kind, desc });
      return orig(desc).catch((err) => {
        rec.failures.push(`${desc.label}: ${String(err?.message ?? err).trim()}`);
        throw err;
      });
    });
  }

  const quiet = console.log;
  console.log = () => {};
  let scopeErrors;
  try {
    scopeErrors = await captureGpuErrors(device, async () => {
      const cache = new app.PipelineLayoutCache(device, { colorTargets, depthFormat });
      const getPl = cache.getPipelineLayout.bind(cache);
      cache.getPipelineLayout = (name) => { rec.usedLayouts.add(name); return getPl(name); };
      rec.cache = cache;
      const shaders = new app.MultiDeviceShaders();
      const field = shaders.fieldShaders;
      const msaa = { sampleCount: 4 };
      // Every ensure* on the cache. A rejected one is already in rec.failures
      // (per pipeline); keep going so one run lists every broken pipeline.
      const jobs = [
        () => cache.ensureDevicePipelines(shaders),
        () => cache.ensureDevicePipelines(shaders, msaa),
        () => cache.ensureShadowCasterPipelines(shaders),
        () => cache.ensureEnergyPipePipeline(shaders),
        () => cache.ensureEnergyPipePipeline(shaders, msaa),
        () => cache.ensureEnergyPipeComputePipeline(shaders),
        () => cache.ensureOverviewCullPipeline(shaders),
        () => cache.ensureSkyPipeline(shaders),
        () => cache.ensureSkyPipeline(shaders, msaa),
        () => cache.ensureGridPipeline(shaders),
        () => cache.ensureGridPipeline(shaders, msaa),
        () => cache.ensureAnomalyWallPipeline(shaders),
        () => cache.ensureAnomalyWallPipeline(shaders, msaa),
        () => cache.ensureBloomPipelines(shaders),
        () => cache.ensureSsrPipeline(shaders.ssrComputeShader),
        () => cache.ensureIblPrefilterPipeline(shaders.iblPrefilterComputeShader),
        () => cache.ensureTaaResolvePipeline(shaders, cache.sceneFormat),
        () => cache.ensureDepthResolvePipeline(shaders),
        () => cache.ensureRollerComputePipeline(shaders.segRollerComputeShader),
        () => cache.ensureFieldAdvectPipeline(shaders.segFieldAdvectShader),
        () => cache.ensureChoresReducePipeline(shaders.choresReduceShader),
        () => cache.ensureTransformerFluxPipeline(shaders.transformerFluxShader),
        () => cache.ensureFluxTracerPipeline(shaders.fluxLineTracerShader),
        () => cache.ensureFdtdComputePipelines(shaders.fdtdTmzComputeShader),
        () => cache.ensureFdtdSlicePipeline(shaders.fdtdSliceShader),
        () => cache.ensureFdtdSlicePipeline(shaders.fdtdSliceShader, msaa),
        () => cache.ensureFieldComputePipelines(field),
        () => cache.ensureFieldRenderPipelines(field),
        () => cache.ensureFieldRenderPipelines(field, msaa),
        () => cache.ensureMpmPipelines(app.MPM_SHADERS),
        () => app.ensureFluidSurfacePipelines(cache, app.FLUID_SURFACE_SHADERS)
      ];
      rec.ensureCalls = jobs.length;
      // A factory can also reject before it creates anything (a missing
      // layout, a thrown TypeError) — that never reaches the wrappers above.
      await Promise.all(jobs.map((job, i) => job().catch((err) => {
        rec.ensureFailures.push(`ensure job ${i} (${job.toString().replace(/^\(\) => /, '')}): ${String(err?.message ?? err).trim()}`);
      })));
    });
  } finally {
    console.log = quiet;
  }

  rec.compile = [];
  for (const m of rec.modules) {
    const info = await m.module.getCompilationInfo();
    for (const msg of info.messages) {
      rec.compile.push({ label: m.label, type: msg.type, text: `${m.label}:${msg.lineNum}:${msg.linePos} ${msg.message}` });
    }
  }
  return { device, colorTargets, requiredFeatures, requiredLimits, scopeErrors, ...rec };
}

/** `ensure*` methods of the cache — the test must call each one. */
function ensureMethods(cache) {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(cache)).filter((n) => n.startsWith('ensure')).sort();
}

describe('test:pipelines — Tint + Dawn compile of every production pipeline', { skip }, () => {
  /** Recorded sessions, reused by the layout / limit checks below. */
  const built = [];

  for (const session of SESSIONS) {
    for (const depthFormat of skip ? [] : DEPTH_FORMATS) {
      it(`${session.name} · ${depthFormat}`, async () => {
        const r = await buildSession(session, depthFormat);
        built.push(r);
        for (const w of r.compile.filter((c) => c.type !== 'error')) console.log(`  [${w.type}] ${w.text}`);
        const errors = r.compile.filter((c) => c.type === 'error').map((c) => c.text);
        assert.deepEqual(errors, [], 'shader compile errors');
        assert.deepEqual(r.failures, [], 'pipelines Dawn rejected');
        // A rejected pipeline rejects its factory too (already listed above);
        // what is left is a factory that threw on its own.
        const own = r.ensureFailures.filter((e) => !r.failures.some((f) => e.endsWith(f.slice(f.indexOf(': ') + 2))));
        assert.deepEqual(own, [], 'ensure* factories that rejected before creating a pipeline');
        assert.deepEqual(r.scopeErrors, [], 'validation errors outside pipeline creation (layouts, modules)');
        assert.deepEqual(r.device.uncaptured, [], 'uncaptured device errors');
        assert.ok(r.pipelines.length >= 40, `only ${r.pipelines.length} pipelines were created`);
        console.log(`  ${r.pipelines.length} pipelines, ${r.modules.length} shader modules · scene ${r.colorTargets.sceneFormat}, `
          + `bloom ${r.colorTargets.bloomFormat}, output ${r.colorTargets.outputFormat}`);
      });
    }
  }

  it('calls every ensure* factory on PipelineLayoutCache', () => {
    const r = built[0];
    assert.ok(r, 'no session was built');
    // One job per method, plus a 4× variant for each of the nine that take a sample count.
    const methods = ensureMethods(r.cache);
    const src = buildSession.toString();
    const missing = methods.filter((m) => !src.includes(`cache.${m}(`));
    assert.deepEqual(missing, [], 'ensure* methods this test never calls — add them to buildSession()');
  });

  it('every registered pipeline layout backs at least one pipeline', () => {
    // Legacy and linear sessions build different bloom pipelines, so the
    // union over sessions is what has to cover the registry.
    const used = new Set(built.flatMap((r) => [...r.usedLayouts]));
    const registered = [...built[0].cache.pipelineLayouts.keys()];
    assert.deepEqual(registered.filter((n) => !used.has(n)), [], 'pipeline layouts no pipeline was compiled against');
    const bglInLayouts = new Set(built[0].layouts.flatMap((l) => l.bgls));
    const orphans = built[0].bgls.filter((b) => !bglInLayouts.has(b.layout)).map((b) => b.label);
    assert.deepEqual(orphans, [], 'bind group layouts in no pipeline layout');
  });

  it('requests the device like webgpu-manager.ts: negotiated features, PREFERRED_LIMITS only', () => {
    const r = built[0];
    const want = app.OPTIONAL_DEVICE_FEATURES.filter((f) => gpu.adapter.features.has(f));
    assert.deepEqual([...r.requiredFeatures].sort(), [...want].sort());
    for (const f of want) assert.ok(r.device.features.has(f), `device lacks ${f}`);
    // A limit left at its core default is the proof that no pipeline needs more.
    for (const [key, def] of Object.entries(CORE_DEFAULT_LIMITS)) {
      if (key in r.requiredLimits) continue;
      assert.equal(r.device.limits[key], def, `${key}: device was not created at the core default`);
    }
  });

  it('every OPTIONAL_DEVICE_FEATURES entry has a consumer (#171)', async () => {
    /** feature → proof that something uses it. A new entry without one fails. */
    const consumers = {
      // The linear pipeline's scene / bloom format; without the feature the
      // same pipelines must be rejected, i.e. the request is load-bearing.
      'rg11b10ufloat-renderable': async () => {
        const withIt = app.resolveColorTargets({ mode: 'linear', preferredCanvasFormat: 'bgra8unorm', features: new Set(['rg11b10ufloat-renderable']), hdrRequested: false });
        assert.equal(withIt.sceneFormat, 'rg11b10ufloat');
        if (!gpu.adapter.features.has('rg11b10ufloat-renderable')) return;
        const bare = await nodeDevice(gpu, { label: 'test-no-rg11b10' });
        const errors = await captureGpuErrors(bare, async () => {
          const cache = new app.PipelineLayoutCache(bare, { colorTargets: withIt, depthFormat: DEPTH_FORMATS[0] });
          await cache.ensureSkyPipeline(new app.MultiDeviceShaders());
        });
        assert.ok(errors.length > 0, 'rg11b10ufloat scene pipelines compiled without the feature — it is no longer needed');
      },
      // Asset path, not a pipeline: the KTX2 loader picks its transcode target
      // from the device's features (src/assets/gltf/ktx2-gpu.ts).
      ...Object.fromEntries(['bc', 'etc2', 'astc'].map((kind) => [`texture-compression-${kind}`, () => {
        const picked = app.selectTextureCompression({ features: new Set([`texture-compression-${kind}`]) }, { fallback: false, software: false });
        assert.equal(picked, kind);
      }]))
    };
    assert.deepEqual(
      [...app.OPTIONAL_DEVICE_FEATURES].sort(), Object.keys(consumers).sort(),
      'OPTIONAL_DEVICE_FEATURES changed — add (or remove) the consumer proof in test:pipelines'
    );
    for (const check of Object.values(consumers)) await check();
  });

  it('every PREFERRED_LIMITS key is exceeded by a measured need (#171)', () => {
    const r = built[0];
    const need = measureNeeds(r);
    for (const [key, value] of Object.entries(need)) {
      const granted = r.device.limits[key];
      assert.ok(value <= granted, `${key}: pipelines need ${value}, device grants ${granted}`);
    }
    for (const [key, asked] of Object.entries(app.PREFERRED_LIMITS)) {
      assert.ok(key in need, `PREFERRED_LIMITS.${key}: test:pipelines has no measurement for it — add one to measureNeeds()`);
      assert.ok(need[key] > CORE_DEFAULT_LIMITS[key], `PREFERRED_LIMITS.${key} = ${asked}, but pipelines need ${need[key]} ≤ the core default ${CORE_DEFAULT_LIMITS[key]}`);
      assert.ok(asked >= need[key], `PREFERRED_LIMITS.${key} = ${asked} is below the measured need ${need[key]}`);
    }
    console.log(`  measured needs: ${Object.entries(need).map(([k, v]) => `${k}=${v}/${CORE_DEFAULT_LIMITS[k]}`).join(' ')}`);
  });
});

/** Largest per-limit demand over the recorded layouts and pipelines. */
function measureNeeds(r) {
  const need = Object.fromEntries(Object.keys(CORE_DEFAULT_LIMITS).map((k) => [k, 0]));
  const bump = (key, v) => { need[key] = Math.max(need[key], v); };
  const STAGES = [GPUShaderStage.VERTEX, GPUShaderStage.FRAGMENT, GPUShaderStage.COMPUTE];
  const entriesOf = new Map(r.bgls.map((b) => [b.layout, b.entries]));

  for (const pl of r.layouts) {
    bump('maxBindGroups', pl.bgls.length);
    const all = pl.bgls.flatMap((l) => entriesOf.get(l) ?? []);
    for (const l of pl.bgls) bump('maxBindingsPerBindGroup', Math.max(0, ...(entriesOf.get(l) ?? []).map((e) => e.binding + 1)));
    bump('maxDynamicUniformBuffersPerPipelineLayout', all.filter((e) => e.buffer?.hasDynamicOffset && (e.buffer.type ?? 'uniform') === 'uniform').length);
    bump('maxDynamicStorageBuffersPerPipelineLayout', all.filter((e) => e.buffer?.hasDynamicOffset && (e.buffer.type ?? 'uniform') !== 'uniform').length);
    for (const stage of STAGES) {
      const seen = all.filter((e) => e.visibility & stage);
      bump('maxUniformBuffersPerShaderStage', seen.filter((e) => e.buffer && (e.buffer.type ?? 'uniform') === 'uniform').length);
      bump('maxStorageBuffersPerShaderStage', seen.filter((e) => e.buffer && (e.buffer.type ?? 'uniform') !== 'uniform').length);
      bump('maxSampledTexturesPerShaderStage', seen.filter((e) => e.texture).length);
      bump('maxSamplersPerShaderStage', seen.filter((e) => e.sampler).length);
      bump('maxStorageTexturesPerShaderStage', seen.filter((e) => e.storageTexture).length);
    }
  }
  for (const { kind, desc } of r.pipelines) {
    if (kind === 'createRenderPipelineAsync') {
      const buffers = (desc.vertex.buffers ?? []).filter(Boolean);
      bump('maxVertexBuffers', buffers.length);
      bump('maxVertexAttributes', buffers.reduce((n, b) => n + b.attributes.length, 0));
      bump('maxVertexBufferArrayStride', Math.max(0, ...buffers.map((b) => b.arrayStride)));
      const targets = (desc.fragment?.targets ?? []).filter(Boolean);
      bump('maxColorAttachments', targets.length);
      bump('maxColorAttachmentBytesPerSample', app.colorAttachmentBytesPerSample(targets.map((t) => t.format)));
    } else {
      // @workgroup_size of the entry point; literals only (every pass uses them).
      const code = r.modules.find((m) => m.module === desc.compute.module)?.code ?? '';
      const at = code.search(new RegExp(`fn\\s+${desc.compute.entryPoint}\\s*\\(`));
      const head = at >= 0 ? code.slice(0, at) : '';
      const m = [...head.matchAll(/@workgroup_size\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?(?:,\s*(\d+)\s*)?\)/g)].pop();
      assert.ok(m, `${desc.label}: no literal @workgroup_size before fn ${desc.compute.entryPoint}`);
      const [x, y, z] = [Number(m[1]), Number(m[2] ?? 1), Number(m[3] ?? 1)];
      bump('maxComputeWorkgroupSizeX', x);
      bump('maxComputeWorkgroupSizeY', y);
      bump('maxComputeWorkgroupSizeZ', z);
      bump('maxComputeInvocationsPerWorkgroup', x * y * z);
    }
  }
  // Tint computes workgroup storage exactly; the device sits at the core
  // default, so a compiled pipeline is the measurement.
  delete need.maxComputeWorkgroupStorageSize;
  return need;
}
