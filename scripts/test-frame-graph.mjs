#!/usr/bin/env node
/**
 * src/visualizer/frame-graph.ts and the WebGPU pass list in render-encode.ts.
 *
 * Graph (mock encoder, no GPU):
 *  1. Order: a read with no earlier writer throws in strict mode; non-strict
 *     warns once and skips the pass; imported resources need no writer; a
 *     pass that returns false does not count as having written.
 *  2. Lifetimes: ensured the first frame a pass touches them (once per shared
 *     lifetime), released after `releaseAfterFrames` untouched frames, all
 *     released by releaseAll().
 *  3. Timestamps: slots only for passes that ask, begin/end split across
 *     sub-passes, capacity respected, `queriesUsed` covers the last slot.
 *  4. One debug group per pass.
 *
 * Pass list (real render-encode.ts / render-passes.ts / post-targets.ts /
 * scene-post-buffers.ts on a mock host and device):
 *  5. Tier × view matrix: which passes run, no order error in strict mode,
 *     and which lazy targets exist — MSAA only at high tier in focus, never
 *     in overview or below high; SSR / TAA / history follow their gates.
 *  6. Leaving the showroom view releases the MSAA set after the hysteresis,
 *     and the profiler's tracked bytes drop with it.
 *  7. Timing on: every encoded GPU pass gets a timestamp slot.
 *  8. Lazy pipeline tiers (#225 §3): the first high/focus frame runs without
 *     MSAA / shadow while they compile; overview never compiles MSAA or the
 *     shadow casters. Key-light shadow (#225 §4): focus/high only, depth-only
 *     casters, one 2048² depth32float map, survives a canvas resize.
 *
 * Usage: node scripts/test-frame-graph.mjs   (exit 1 on failure)
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Stub Vite's `?raw` shader-text imports so app-reaching graphs still bundle. */
const viteRawStub = {
  name: 'vite-raw-stub',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: args.path, namespace: 'raw-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
  }
};

// WebGPU enums the modules read at call time.
globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
globalThis.GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, QUERY_RESOLVE: 512 };
globalThis.GPUMapMode = { READ: 1 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.requestAnimationFrame = () => 0;

const result = await esbuild.build({
  stdin: {
    contents: [
      "export * from './src/visualizer/frame-graph.ts';",
      "export { renderEncodeMethods, POST_TARGET_RELEASE_FRAMES } from './src/visualizer/render-encode.ts';",
      "export { postTargetMethods, postTargetBytes } from './src/visualizer/post-targets.ts';",
      "export { scenePostBufferMethods } from './src/visualizer/scene-post-buffers.ts';",
      "export { BloomChain } from './src/visualizer/bloom-chain.ts';",
      "export { PipelineTiers } from './src/visualizer/pipeline-tiers.ts';",
      "export { ShadowMap, SHADOW_MAP_SIZE } from './src/visualizer/shadow-map.ts';",
      "export { FrameBindings } from './src/visualizer/frame-bindings.ts';",
      "export { UniformRing } from './src/visualizer/uniform-ring.ts';"
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  write: false,
  logLevel: 'silent',
  loader: { '.wgsl': 'text', '.glsl': 'text' },
  define: { 'import.meta.url': '"file:///stub/frame-graph-test.js"', 'import.meta.env': '{"DEV":true}' },
  plugins: [viteRawStub]
});
const {
  FrameGraph, FrameGraphOrderError, renderEncodeMethods, POST_TARGET_RELEASE_FRAMES,
  postTargetMethods, postTargetBytes, scenePostBufferMethods, BloomChain,
  PipelineTiers, ShadowMap, SHADOW_MAP_SIZE, FrameBindings, UniformRing
} = await import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (!cond) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
}

/** Records GPU passes and debug groups; enough of GPUCommandEncoder for the graph and the pass bodies. */
function mockEncoder() {
  const log = { passes: [], groups: [], copies: 0, depth: 0, maxDepth: 0 };
  const passEncoder = (desc) => {
    log.passes.push({ label: desc?.label, ts: desc?.timestampWrites });
    return {
      setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {},
      draw() {}, drawIndexed() {}, drawIndirect() {}, drawIndexedIndirect() {},
      dispatchWorkgroups() {}, end() {}
    };
  };
  return {
    log,
    beginRenderPass: passEncoder,
    beginComputePass: passEncoder,
    copyTextureToTexture() { log.copies++; },
    pushDebugGroup(name) { log.groups.push(name); log.depth++; log.maxDepth = Math.max(log.maxDepth, log.depth); },
    popDebugGroup() { log.depth--; },
    finish() { return {}; }
  };
}

const lifetime = (name) => {
  const l = { name, allocated: false, ensures: 0, releases: 0 };
  l.isAllocated = () => l.allocated;
  l.ensure = () => { l.allocated = true; l.ensures++; };
  l.release = () => { l.allocated = false; l.releases++; };
  return l;
};

// ── 1. Order ────────────────────────────────────────────────────
{
  const strict = new FrameGraph({ label: 't', strict: true });
  strict.addResource('a').addResource('b');
  strict.addPass('reader', { reads: ['a'], encode() {} });
  strict.addPass('writer', { writes: ['a'], encode() {} });
  let threw = null;
  try { strict.execute(mockEncoder(), {}); } catch (e) { threw = e; }
  check('strict: read before its writer throws FrameGraphOrderError', threw instanceof FrameGraphOrderError, String(threw));

  const warnings = [];
  const loose = new FrameGraph({ label: 't', strict: false, warn: (m) => warnings.push(m) });
  loose.addResource('a');
  loose.addPass('reader', { reads: ['a'], encode() {} });
  loose.addPass('writer', { writes: ['a'], encode() {} });
  const r1 = loose.execute(mockEncoder(), {});
  loose.execute(mockEncoder(), {});
  check('non-strict: the bad pass is skipped', r1.ran.join() === 'writer', r1.ran.join());
  check('non-strict: warns once, not every frame', warnings.length === 1, `${warnings.length} warnings`);

  const imp = new FrameGraph({ label: 't', strict: true });
  imp.addResource('history', { imported: true }).addResource('out');
  imp.addPass('use', { reads: ['history'], writes: ['out'], encode() {} });
  check('imported resource needs no writer', imp.execute(mockEncoder(), {}).ran.join() === 'use');

  const bail = new FrameGraph({ label: 't', strict: true });
  bail.addResource('x');
  bail.addPass('producer', { writes: ['x'], encode: () => false });
  bail.addPass('consumer', { reads: ['x'], encode() {} });
  threw = null;
  try { bail.execute(mockEncoder(), {}); } catch (e) { threw = e; }
  check('a pass that returned false did not write', threw instanceof FrameGraphOrderError);

  // Dynamic reads see gates a bailing pass cleared.
  const dyn = new FrameGraph({ label: 't', strict: true });
  dyn.addResource('raw').addResource('taa');
  dyn.addPass('scene', { writes: ['raw'], encode() {} });
  dyn.addPass('taa', { enabled: (c) => c.taa, writes: ['taa'], encode: (_e, _r, c) => { c.taa = false; return false; } });
  dyn.addPass('composite', { reads: (c) => [c.taa ? 'taa' : 'raw'], encode() {} });
  const rd = dyn.execute(mockEncoder(), { taa: true });
  check('reads are evaluated after earlier passes ran', rd.ran.join() === 'scene,composite', rd.ran.join());

  let undeclared = null;
  const und = new FrameGraph({ label: 't', strict: true });
  und.addPass('p', { reads: ['nope'], encode() {} });
  try { und.execute(mockEncoder(), {}); } catch (e) { undeclared = e; }
  check('undeclared resource throws', !!undeclared && /undeclared/.test(undeclared.message));

  let dup = null;
  try { new FrameGraph({ label: 't', strict: true }).addPass('p', { encode() {} }).addPass('p', { encode() {} }); }
  catch (e) { dup = e; }
  check('duplicate pass name throws', !!dup);
}

// ── 2. Lifetimes ────────────────────────────────────────────────
{
  const msaa = lifetime('msaa');
  const g = new FrameGraph({ label: 't', strict: true, releaseAfterFrames: 3 });
  g.addResource('colorMsaa', { lifetime: msaa }).addResource('depthMsaa', { lifetime: msaa });
  g.addPass('scene', { enabled: (c) => c.on, writes: ['colorMsaa', 'depthMsaa'], encode() {} });

  const r0 = g.execute(mockEncoder(), { on: false });
  check('gated-off pass allocates nothing', !msaa.allocated && r0.allocated.length === 0);
  const r1 = g.execute(mockEncoder(), { on: true });
  check('first touching frame allocates', msaa.allocated && r1.allocated.join() === 'msaa', r1.allocated.join());
  check('shared lifetime ensured once', msaa.ensures === 1, `${msaa.ensures}`);
  g.execute(mockEncoder(), { on: true });
  check('already allocated: no second ensure', msaa.ensures === 1);
  const released = [];
  for (let i = 0; i < 4; i++) released.push(...g.execute(mockEncoder(), { on: false }).released);
  check('released after releaseAfterFrames untouched frames', !msaa.allocated && released.join() === 'msaa',
    `allocated=${msaa.allocated} released=${released.join()}`);
  // Exactly the hysteresis: 3 idle frames keep it, the 4th releases.
  const m2 = lifetime('m2');
  const h = new FrameGraph({ label: 't', strict: true, releaseAfterFrames: 3 });
  h.addResource('r', { lifetime: m2 });
  h.addPass('p', { enabled: (c) => c.on, writes: ['r'], encode() {} });
  h.execute(mockEncoder(), { on: true });
  for (let i = 0; i < 3; i++) h.execute(mockEncoder(), { on: false });
  check('kept for releaseAfterFrames idle frames', m2.allocated);
  h.execute(mockEncoder(), { on: false });
  check('dropped on the next one', !m2.allocated);

  g.execute(mockEncoder(), { on: true });
  g.releaseAll();
  check('releaseAll releases', !msaa.allocated && msaa.releases === 2, `${msaa.releases}`);
  check('allocatedLifetimes reflects state', g.allocatedLifetimes().length === 0);
}

// ── 3. Timestamps ───────────────────────────────────────────────
{
  const querySet = { label: 'qs' };
  const g = new FrameGraph({ label: 't', strict: true });
  g.addResource('a');
  g.addPass('single', { writes: ['a'], encode: (e, r) => { e.beginRenderPass({ label: 's', timestampWrites: r.timestamps('both') }); } });
  g.addPass('untimed', { encode: (e) => { e.copyTextureToTexture(); } });
  g.addPass('multi', {
    encode: (e, r) => {
      e.beginRenderPass({ label: 'm0', timestampWrites: r.timestamps('begin') });
      e.beginRenderPass({ label: 'm1' });
      e.beginRenderPass({ label: 'm2', timestampWrites: r.timestamps('end') });
    }
  });
  g.addPass('half', { encode: (e, r) => { e.beginRenderPass({ label: 'h', timestampWrites: r.timestamps('begin') }); } });

  const off = g.execute(mockEncoder(), {}, null);
  check('timing off: no slots', off.timedPasses.length === 0 && off.queriesUsed === 0);

  const enc = mockEncoder();
  const on = g.execute(enc, {}, { querySet, queryCount: 32 });
  const names = on.timedPasses.map((t) => `${t.name}@${t.slot}`).join();
  check('slots in order, untimed pass skipped, half-timed dropped', names === 'single@0,multi@1', names);
  const s = enc.log.passes.find((p) => p.label === 's').ts;
  check('both → begin 0 / end 1', s.beginningOfPassWriteIndex === 0 && s.endOfPassWriteIndex === 1 && s.querySet === querySet);
  const m0 = enc.log.passes.find((p) => p.label === 'm0').ts;
  const m2 = enc.log.passes.find((p) => p.label === 'm2').ts;
  check('multi-pass: begin on first, end on last',
    m0.beginningOfPassWriteIndex === 2 && m0.endOfPassWriteIndex === undefined
    && m2.endOfPassWriteIndex === 3 && m2.beginningOfPassWriteIndex === undefined);
  check('queriesUsed covers the last complete slot', on.queriesUsed === 4, `${on.queriesUsed}`);

  const tight = g.execute(mockEncoder(), {}, { querySet, queryCount: 2 });
  check('capacity: only one slot when the set holds two queries',
    tight.timedPasses.map((t) => t.name).join() === 'single', tight.timedPasses.map((t) => t.name).join());

  check('one debug group per pass, balanced', enc.log.groups.join() === 'single,untimed,multi,half'
    && enc.log.depth === 0 && enc.log.maxDepth === 1, enc.log.groups.join());
}

// ── 5–7. The real pass list ─────────────────────────────────────
function mockDevice() {
  const live = new Set();
  let self = null;
  const tex = (desc) => {
    const t = {
      label: desc.label, format: desc.format, sampleCount: desc.sampleCount ?? 1, usage: desc.usage,
      destroyed: false,
      createView: (v = {}) => ({ texture: t, ...v }),
      destroy() { t.destroyed = true; live.delete(t); }
    };
    live.add(t);
    return t;
  };
  return self = {
    live,
    createTexture: tex,
    createBuffer: (d) => ({ label: d.label, size: d.size, destroy() {} }),
    createSampler: () => ({}),
    createBindGroup: (d) => ({ label: d.label, entries: d.entries }),
    createCommandEncoder: () => mockEncoder(),
    /** Last data written per buffer label (post uniforms are checked below). */
    writes: new Map(),
    queue: {
      writeBuffer(buffer, _offset, data, dataOffset = 0, size) {
        const f = ArrayBuffer.isView(data)
          ? new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4)
          : new Float32Array(data, dataOffset, (size ?? data.byteLength - dataOffset) / 4);
        self.writes.set(buffer.label, Float32Array.from(f));
      },
      submit() {}
    }
  };
}

function mockProfiler() {
  const tracked = new Map();
  return {
    qualityTier: 'high', postQualityTier: 'high', qualityLevel: 1,
    timingEnabled: false, msaaActive: false, taaActive: false,
    trackTexture(name, w, h, _f, samples = 1, bytes) { tracked.set(name, bytes ?? w * h * 4 * samples); },
    untrackTextures(names) { for (const n of names) tracked.delete(n); },
    trackBuffer() {},
    measureDevice(_n, fn) { fn(); },
    endFrameCpu() {},
    gpuTimestampTarget() { return this.timingEnabled ? { querySet: { label: 'qs' }, queryCount: 32 } : null; },
    scheduleResolveTimestamps(passes) { this.lastTimed = passes.map((p) => p.name); },
    tracked
  };
}

/** A focused bench: records what the shadow and scene passes asked of it. */
function mockBench() {
  const log = [];
  const pm = {
    variant: 'base',
    applyPassVariant(v) { this.variant = v; log.push(`variant:${v}`); },
    applyMsaaState(on) { this.variant = on ? 'msaa4' : 'base'; }
  };
  return {
    id: 'seg', position: [0, 0, 0], config: {}, pipelineManager: pm, log,
    render: () => log.push(`render:${pm.variant}`),
    renderShadowCasters: () => log.push(`casters:${pm.variant}`)
  };
}

function mockHost({ tier = 'high', overview = false, readyTiers = true } = {}) {
  const device = mockDevice();
  const profiler = mockProfiler();
  profiler.qualityTier = tier;
  profiler.postQualityTier = tier;
  const pipeline = { label: 'pipe' };
  const compiled = [];
  const compile = (name) => () => { compiled.push(name); return Promise.resolve({ label: name }); };
  const host = {
    device,
    profiler,
    compiled,
    currentView: 'seg',
    time: 0,
    lightingConfig: { key: { position: [6, 9, 7] }, shadowStrength: 0.6 },
    shaders: {},
    globalUniformBuffer: { label: 'globals' },
    segLayoutUniformBuffer: { label: 'seg-layout' },
    lightingUniformBuffer: { label: 'lighting' },
    materialTableBuffer: { label: 'materials' },
    iblResources: { view: { label: 'ibl' }, sampler: {} },
    _rebuildDepthResolveBindGroup() {},
    canvas: { width: 64, height: 32, clientWidth: 64, clientHeight: 32 },
    webgpu: { depthFormat: 'depth24plus' },
    depthFormat: 'depth24plus',
    devices: {},
    energyPipes: [],
    simRateController: { speedMult: 1 },
    globalEnergyLevel: 0,
    corona: 0,
    postPreset: { post: { exposure: 1, bloomStrength: 0.5 }, sky: {}, lighting: {} },
    pipelineCache: {
      sceneFormat: 'rg11b10ufloat',
      bloomFormat: 'rg11b10ufloat',
      colorTargets: { mode: 'linear', hdrOutput: false, outputFormat: 'bgra8unorm-srgb', shaderEncodesOutput: false },
      createBindGroup: (_name, entries, label) => ({ label, entries }),
      ensureSkyPipeline: compile('sky'),
      ensureGridPipeline: compile('grid'),
      ensureAnomalyWallPipeline: compile('anomaly'),
      ensureEnergyPipePipeline: compile('energyPipe'),
      ensureDepthResolvePipeline: compile('depthResolve'),
      ensureDevicePipelines: (_s, o) => compile(o?.sampleCount === 4 ? 'device_msaa4' : 'device')(),
      ensureSsrPipeline: compile('ssr'),
      ensureTaaResolvePipeline: compile('taa'),
      ensureShadowCasterPipelines: compile('shadowCasters')
    },
    cameraController: {
      getViewProjMatrix: () => new Float32Array(16),
      getProjMatrix: () => new Float32Array(16),
      invertMatrix: (m) => new Float32Array(m)
    },
    isOverviewMode: () => overview,
    render() {},
    // Pipelines the gates check for (the lazy tiers set the rest).
    taaPipeline: pipeline,
    ssrPipeline: pipeline,
    bloomCompositePipeline: pipeline,
    bloomSampler: {},
    bloomParamsBuffer: { label: 'bloom-params' },
    ssrParamsBuffer: { label: 'ssr-params' },
    taaParamsBuffer: { label: 'taa-params' }
  };
  Object.assign(host, postTargetMethods, scenePostBufferMethods, renderEncodeMethods);
  host.renderAnomalyWalls = () => {};
  host.devices = { seg: mockBench() };
  host.uniformRing = new UniformRing(device, { slots: 8 });
  host.pipelineTiers = new PipelineTiers(host);
  host.shadowMap = new ShadowMap(host);
  host.frameBindings = new FrameBindings(host);
  // Most sections test the graph, not compile latency: mark every tier ready.
  if (readyTiers) {
    for (const t of ['msaa', 'ssr', 'taa', 'shadow']) host.pipelineTiers.states[t] = 'ready';
    host.depthResolvePipeline = pipeline;
  }
  host.setupDepthBuffer();
  host.bloomChain = new BloomChain(device, 'rg11b10ufloat');
  host.bloomChainPipelines = { prefilter: pipeline, downsample: pipeline, upsample: pipeline };
  host.setupBloomTextures();
  return host;
}

const frame = (host) => host._encodeFrame(host.profiler, { label: 'globals' }, {
  getCurrentTexture: () => ({ createView: () => ({}) })
}, null, false, () => true, null);

const matrix = [
  // tier, overview, expected passes, expected lazy targets
  ['high', false, 'compute,shadow,scene,depth-resolve,taa,ssr,bloom,composite,history', 'msaa,shadow,ssr,taa,history'],
  ['high', true, 'compute,scene,ssr,bloom,composite', 'ssr'],
  ['medium', false, 'compute,scene,bloom,composite', ''],
  ['medium', true, 'compute,scene,bloom,composite', ''],
  ['low', false, 'compute,scene,bloom,composite', ''],
  ['critical', false, 'compute,scene,composite', '']
];
for (const [tier, overview, passes, lazy] of matrix) {
  const host = mockHost({ tier, overview });
  let err = null;
  try { frame(host); frame(host); } catch (e) { err = e; }
  const tag = `${tier}/${overview ? 'overview' : 'focus'}`;
  check(`${tag}: no order error`, !err, err?.message);
  const ran = host._frameGraphReport?.ran.join() ?? '';
  check(`${tag}: passes`, ran === passes, ran);
  const allocated = host._frameGraph.allocatedLifetimes().sort().join();
  check(`${tag}: lazy targets`, allocated === lazy.split(',').filter(Boolean).sort().join(), allocated || '(none)');
  if (!lazy.includes('msaa')) {
    check(`${tag}: no 4× textures exist`, ![...host.device.live].some((t) => t.sampleCount === 4));
  }
}

// High-speed sim at medium tier: motion blur needs history, not TAA.
{
  /** BloomParams.motionBlur (packPostUniforms slot 10) as last uploaded. */
  const blur = (host) => host.device.writes.get('bloom-params')?.[10] ?? NaN;
  const host = mockHost({ tier: 'medium' });
  frame(host);
  check('medium, normal speed: no history copy, no history target',
    !host._frameGraphReport.ran.includes('history') && host._frameGraph.allocatedLifetimes().length === 0);
  host.simRateController.speedMult = 15;
  frame(host);
  check('medium + motion blur: history allocated', host._frameGraph.allocatedLifetimes().join() === 'history');
  check('…not blended the frame it was allocated (uninitialised)', blur(host) === 0, `${blur(host)}`);
  frame(host);
  check('…blended from the next frame on', blur(host) > 0, `${blur(host)}`);
  host.simRateController.speedMult = 1;
  frame(host);
  host.simRateController.speedMult = 15;
  frame(host);
  check('a skipped copy leaves a stale history: not blended on return', blur(host) === 0, `${blur(host)}`);
}

// 6. Focus → overview releases the MSAA set after the hysteresis.
{
  const host = mockHost({ tier: 'high' });
  frame(host);
  const before = postTargetBytes(Object.fromEntries(host.profiler.tracked));
  const msaaTextures = [...host.device.live].filter((t) => t.sampleCount === 4);
  check('focus/high: 4× textures exist', msaaTextures.length === 3, `${msaaTextures.length}`);
  check('MSAA colour pair is render-attachment only',
    msaaTextures.filter((t) => t.format !== 'depth24plus').every((t) => t.usage === GPUTextureUsage.RENDER_ATTACHMENT));
  host.isOverviewMode = () => true;
  for (let i = 0; i < POST_TARGET_RELEASE_FRAMES; i++) frame(host);
  check('within the hysteresis the MSAA set is kept', host._frameGraph.allocatedLifetimes().includes('msaa'));
  frame(host);
  const after = postTargetBytes(Object.fromEntries(host.profiler.tracked));
  check('after it, MSAA (and TAA / history) are released',
    host._frameGraph.allocatedLifetimes().join() === 'ssr', host._frameGraph.allocatedLifetimes().join());
  check('released textures are destroyed', msaaTextures.every((t) => t.destroyed));
  check('postTargetBytes drops', after < before, `${before} → ${after}`);
  check('composite rebound to placeholders',
    host.bloomCompositeBindGroup.entries.find((e) => e.binding === 5).resource.texture.label === 'placeholder-history');
  host.isOverviewMode = () => false;
  frame(host);
  check('back to focus: reallocated', host._frameGraph.allocatedLifetimes().includes('msaa'));

  // Resize drops every lazy target; the next frame brings back what it uses.
  host.setupDepthBuffer();
  host.setupBloomTextures();
  check('resize: only the (canvas-independent) shadow map is left',
    host._frameGraph.allocatedLifetimes().join() === 'shadow', host._frameGraph.allocatedLifetimes().join());
  frame(host);
  check('resize: next frame reallocates',
    host._frameGraph.allocatedLifetimes().sort().join() === 'history,msaa,shadow,ssr,taa',
    host._frameGraph.allocatedLifetimes().sort().join());
}

// 7. Timing: every encoded GPU pass gets a slot.
{
  const host = mockHost({ tier: 'high' });
  host.profiler.timingEnabled = true;
  frame(host);
  const timed = host._frameGraphReport.timedPasses.map((t) => t.name).join();
  check('timing: every GPU pass is timed (history is a copy)',
    timed === 'compute,shadow,scene,depth-resolve,taa,ssr,bloom,composite', timed);
  check('timing: profiler got the slot map', host.profiler.lastTimed?.join() === timed);
}

// 8. Lazy tiers + the key-light shadow.
{
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const host = mockHost({ tier: 'high', readyTiers: false });
  frame(host);
  check('first focus/high frame: no MSAA, no shadow while compiling',
    !host._frameGraphReport.ran.includes('shadow') && !host._frameGraphReport.ran.includes('depth-resolve'),
    host._frameGraphReport.ran.join());
  check('…tiers started', ['msaa', 'shadow'].every((t) => host.pipelineTiers.state(t) === 'compiling'));
  await settle();
  frame(host);
  check('after compile: shadow + MSAA run', ['shadow', 'depth-resolve'].every((p) => host._frameGraphReport.ran.includes(p)),
    host._frameGraphReport.ran.join());
  check('msaa tier compiled every 4× variant + depth resolve, once',
    ['device_msaa4', 'sky', 'grid', 'anomaly', 'energyPipe', 'depthResolve'].every((n) => host.compiled.includes(n))
    && host.compiled.filter((n) => n === 'device_msaa4').length === 1, host.compiled.join());

  const bench = host.devices.seg;
  check('casters drawn with the depth-only variant, then back to base',
    bench.log.includes('casters:shadow') && bench.log.at(-1) !== 'variant:shadow'
    && !bench.log.includes('render:shadow'), bench.log.join());
  const map = [...host.device.live].find((t) => t.label === 'shadow-map');
  check('one 2048² depth32float map', !!map && map.format === 'depth32float'
    && [...host.device.live].filter((t) => t.label === 'shadow-map').length === 1);
  check('map tracked as a post target', (host.profiler.tracked.get('shadowMap') ?? 0) === SHADOW_MAP_SIZE * SHADOW_MAP_SIZE * 4);
  const su = host.device.writes.get('shadow-uniforms');
  check('receivers see enabled = 1 and strength = lightingConfig.shadowStrength',
    su?.[16] === 1 && Math.abs(su[19] - 0.6) < 1e-6, `${su?.[16]} / ${su?.[19]}`);
  const sceneFrame = host.frameBindings.sceneGroup();
  check('scene frame group samples the real map',
    sceneFrame.entries.find((e) => e.binding === 9).resource.texture === map);
  check('shadow-pass frame group: light Uniforms + placeholder map',
    host.frameBindings.shadowGroup().entries.find((e) => e.binding === 0).resource.buffer.label === 'shadow-caster-uniforms'
    && host.frameBindings.shadowGroup().entries.find((e) => e.binding === 9).resource.texture.label === 'shadow-map-placeholder');

  // Medium tier focus: pass off, receivers told so.
  host.profiler.qualityTier = 'medium';
  frame(host);
  check('medium: no shadow pass', !host._frameGraphReport.ran.includes('shadow'));
  check('medium: receivers see enabled = 0', host.device.writes.get('shadow-uniforms')?.[16] === 0);

  const ov = mockHost({ tier: 'high', overview: true, readyTiers: false });
  frame(ov); await settle(); frame(ov); frame(ov);
  check('overview/high: no shadow pass, ever', !ov._frameGraphReport.ran.includes('shadow'));
  check('overview never compiles MSAA or shadow casters',
    ov.pipelineTiers.state('msaa') === 'idle' && ov.pipelineTiers.state('shadow') === 'idle'
    && !ov.compiled.includes('device_msaa4') && !ov.compiled.includes('shadowCasters'), ov.compiled.join());
  check('overview: no shadow map texture', ![...ov.device.live].some((t) => t.label === 'shadow-map'));
}

if (failures.length) {
  console.error(`[frame-graph] ${failures.length}/${checks} checks failed:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`[frame-graph] ${checks} checks passed`);
