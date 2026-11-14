/* global GPUTextureUsage -- stubbed on globalThis below */
/**
 * frame-graph — src/visualizer/frame-graph.ts and the WebGPU pass list in render-encode.ts.
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
 * Usage: npm run test:frame-graph   (node --test scripts/tests/frame-graph.test.mjs)
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { bundleTs } from '../test-harness.mjs';

// WebGPU enums the modules read at call time.
globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
globalThis.GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, QUERY_RESOLVE: 512 };
globalThis.GPUMapMode = { READ: 1 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.requestAnimationFrame = () => 0;

let FrameGraph, FrameGraphOrderError, renderEncodeMethods, POST_TARGET_RELEASE_FRAMES,
  postTargetMethods, postTargetBytes, scenePostBufferMethods, BloomChain,
  PipelineTiers, ShadowMap, SHADOW_MAP_SIZE, FrameBindings, UniformRing;
before(async () => {
  ({
    FrameGraph, FrameGraphOrderError, renderEncodeMethods, POST_TARGET_RELEASE_FRAMES,
    postTargetMethods, postTargetBytes, scenePostBufferMethods, BloomChain,
    PipelineTiers, ShadowMap, SHADOW_MAP_SIZE, FrameBindings, UniformRing
  } = await bundleTs({
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
    sourcefile: 'frame-graph-entry.ts'
  }, {
    // render-encode.ts builds its graph with `strict: !!import.meta.env?.DEV`: run strict.
    define: { 'import.meta.env': '{"DEV":true}' }
  }));
});

/** `label` or `label: detail`, as the old hand-rolled check() printed it. */
const msg = (label, detail = '') => `${label}${detail ? `: ${detail}` : ''}`;

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

describe('1. order', () => {
  it('strict: read before its writer throws FrameGraphOrderError', () => {
    const strict = new FrameGraph({ label: 't', strict: true });
    strict.addResource('a').addResource('b');
    strict.addPass('reader', { reads: ['a'], encode() {} });
    strict.addPass('writer', { writes: ['a'], encode() {} });
    let threw = null;
    try { strict.execute(mockEncoder(), {}); } catch (e) { threw = e; }
    assert.ok(threw instanceof FrameGraphOrderError, msg('strict: read before its writer throws FrameGraphOrderError', String(threw)));
  });

  it('non-strict: the bad pass is skipped and warns once', () => {
    const warnings = [];
    const loose = new FrameGraph({ label: 't', strict: false, warn: (m) => warnings.push(m) });
    loose.addResource('a');
    loose.addPass('reader', { reads: ['a'], encode() {} });
    loose.addPass('writer', { writes: ['a'], encode() {} });
    const r1 = loose.execute(mockEncoder(), {});
    loose.execute(mockEncoder(), {});
    assert.ok(r1.ran.join() === 'writer', msg('non-strict: the bad pass is skipped', r1.ran.join()));
    assert.ok(warnings.length === 1, msg('non-strict: warns once, not every frame', `${warnings.length} warnings`));
  });

  it('imported resource needs no writer', () => {
    const imp = new FrameGraph({ label: 't', strict: true });
    imp.addResource('history', { imported: true }).addResource('out');
    imp.addPass('use', { reads: ['history'], writes: ['out'], encode() {} });
    assert.ok(imp.execute(mockEncoder(), {}).ran.join() === 'use', msg('imported resource needs no writer'));
  });

  it('a pass that returned false did not write', () => {
    const bail = new FrameGraph({ label: 't', strict: true });
    bail.addResource('x');
    bail.addPass('producer', { writes: ['x'], encode: () => false });
    bail.addPass('consumer', { reads: ['x'], encode() {} });
    let threw = null;
    try { bail.execute(mockEncoder(), {}); } catch (e) { threw = e; }
    assert.ok(threw instanceof FrameGraphOrderError, msg('a pass that returned false did not write'));
  });

  it('reads are evaluated after earlier passes ran', () => {
    // Dynamic reads see gates a bailing pass cleared.
    const dyn = new FrameGraph({ label: 't', strict: true });
    dyn.addResource('raw').addResource('taa');
    dyn.addPass('scene', { writes: ['raw'], encode() {} });
    dyn.addPass('taa', { enabled: (c) => c.taa, writes: ['taa'], encode: (_e, _r, c) => { c.taa = false; return false; } });
    dyn.addPass('composite', { reads: (c) => [c.taa ? 'taa' : 'raw'], encode() {} });
    const rd = dyn.execute(mockEncoder(), { taa: true });
    assert.ok(rd.ran.join() === 'scene,composite', msg('reads are evaluated after earlier passes ran', rd.ran.join()));
  });

  it('undeclared resource throws', () => {
    let undeclared = null;
    const und = new FrameGraph({ label: 't', strict: true });
    und.addPass('p', { reads: ['nope'], encode() {} });
    try { und.execute(mockEncoder(), {}); } catch (e) { undeclared = e; }
    assert.ok(!!undeclared && /undeclared/.test(undeclared.message), msg('undeclared resource throws'));
  });

  it('duplicate pass name throws', () => {
    let dup = null;
    try { new FrameGraph({ label: 't', strict: true }).addPass('p', { encode() {} }).addPass('p', { encode() {} }); }
    catch (e) { dup = e; }
    assert.ok(!!dup, msg('duplicate pass name throws'));
  });
});

describe('2. lifetimes', () => {
  it('ensure once per shared lifetime, release after the hysteresis, releaseAll', () => {
    const msaa = lifetime('msaa');
    const g = new FrameGraph({ label: 't', strict: true, releaseAfterFrames: 3 });
    g.addResource('colorMsaa', { lifetime: msaa }).addResource('depthMsaa', { lifetime: msaa });
    g.addPass('scene', { enabled: (c) => c.on, writes: ['colorMsaa', 'depthMsaa'], encode() {} });

    const r0 = g.execute(mockEncoder(), { on: false });
    assert.ok(!msaa.allocated && r0.allocated.length === 0, msg('gated-off pass allocates nothing'));
    const r1 = g.execute(mockEncoder(), { on: true });
    assert.ok(msaa.allocated && r1.allocated.join() === 'msaa', msg('first touching frame allocates', r1.allocated.join()));
    assert.ok(msaa.ensures === 1, msg('shared lifetime ensured once', `${msaa.ensures}`));
    g.execute(mockEncoder(), { on: true });
    assert.ok(msaa.ensures === 1, msg('already allocated: no second ensure'));
    const released = [];
    for (let i = 0; i < 4; i++) released.push(...g.execute(mockEncoder(), { on: false }).released);
    assert.ok(!msaa.allocated && released.join() === 'msaa',
      msg('released after releaseAfterFrames untouched frames', `allocated=${msaa.allocated} released=${released.join()}`));

    g.execute(mockEncoder(), { on: true });
    g.releaseAll();
    assert.ok(!msaa.allocated && msaa.releases === 2, msg('releaseAll releases', `${msaa.releases}`));
    assert.ok(g.allocatedLifetimes().length === 0, msg('allocatedLifetimes reflects state'));
  });

  it('exactly the hysteresis: 3 idle frames keep it, the 4th releases', () => {
    const m2 = lifetime('m2');
    const h = new FrameGraph({ label: 't', strict: true, releaseAfterFrames: 3 });
    h.addResource('r', { lifetime: m2 });
    h.addPass('p', { enabled: (c) => c.on, writes: ['r'], encode() {} });
    h.execute(mockEncoder(), { on: true });
    for (let i = 0; i < 3; i++) h.execute(mockEncoder(), { on: false });
    assert.ok(m2.allocated, msg('kept for releaseAfterFrames idle frames'));
    h.execute(mockEncoder(), { on: false });
    assert.ok(!m2.allocated, msg('dropped on the next one'));
  });
});

describe('3–4. timestamps + debug groups', () => {
  let g, querySet;
  before(() => {
    querySet = { label: 'qs' };
    g = new FrameGraph({ label: 't', strict: true });
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
  });

  it('timing off: no slots', () => {
    const off = g.execute(mockEncoder(), {}, null);
    assert.ok(off.timedPasses.length === 0 && off.queriesUsed === 0, msg('timing off: no slots'));
  });

  it('timing on: slot layout and one debug group per pass', () => {
    const enc = mockEncoder();
    const on = g.execute(enc, {}, { querySet, queryCount: 32 });
    const names = on.timedPasses.map((t) => `${t.name}@${t.slot}`).join();
    assert.ok(names === 'single@0,multi@1', msg('slots in order, untimed pass skipped, half-timed dropped', names));
    const s = enc.log.passes.find((p) => p.label === 's').ts;
    assert.ok(s.beginningOfPassWriteIndex === 0 && s.endOfPassWriteIndex === 1 && s.querySet === querySet, msg('both → begin 0 / end 1'));
    const m0 = enc.log.passes.find((p) => p.label === 'm0').ts;
    const m2 = enc.log.passes.find((p) => p.label === 'm2').ts;
    assert.ok(m0.beginningOfPassWriteIndex === 2 && m0.endOfPassWriteIndex === undefined
      && m2.endOfPassWriteIndex === 3 && m2.beginningOfPassWriteIndex === undefined,
    msg('multi-pass: begin on first, end on last'));
    assert.ok(on.queriesUsed === 4, msg('queriesUsed covers the last complete slot', `${on.queriesUsed}`));

    const tight = g.execute(mockEncoder(), {}, { querySet, queryCount: 2 });
    assert.ok(tight.timedPasses.map((t) => t.name).join() === 'single',
      msg('capacity: only one slot when the set holds two queries', tight.timedPasses.map((t) => t.name).join()));

    assert.ok(enc.log.groups.join() === 'single,untimed,multi,half'
      && enc.log.depth === 0 && enc.log.maxDepth === 1, msg('one debug group per pass, balanced', enc.log.groups.join()));
  });
});

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

describe('5. tier × view matrix', () => {
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
    const tag = `${tier}/${overview ? 'overview' : 'focus'}`;
    it(`${tag}: no order error, passes, lazy targets`, () => {
      const host = mockHost({ tier, overview });
      let err = null;
      try { frame(host); frame(host); } catch (e) { err = e; }
      assert.ok(!err, msg(`${tag}: no order error`, err?.message));
      const ran = host._frameGraphReport?.ran.join() ?? '';
      assert.ok(ran === passes, msg(`${tag}: passes`, ran));
      const allocated = host._frameGraph.allocatedLifetimes().sort().join();
      assert.ok(allocated === lazy.split(',').filter(Boolean).sort().join(), msg(`${tag}: lazy targets`, allocated || '(none)'));
      if (!lazy.includes('msaa')) {
        assert.ok(![...host.device.live].some((t) => t.sampleCount === 4), msg(`${tag}: no 4× textures exist`));
      }
    });
  }

  it('high-speed sim at medium tier: motion blur needs history, not TAA', () => {
    /** BloomParams.motionBlur (packPostUniforms slot 10) as last uploaded. */
    const blur = (host) => host.device.writes.get('bloom-params')?.[10] ?? NaN;
    const host = mockHost({ tier: 'medium' });
    frame(host);
    assert.ok(!host._frameGraphReport.ran.includes('history') && host._frameGraph.allocatedLifetimes().length === 0,
      msg('medium, normal speed: no history copy, no history target'));
    host.simRateController.speedMult = 15;
    frame(host);
    assert.ok(host._frameGraph.allocatedLifetimes().join() === 'history', msg('medium + motion blur: history allocated'));
    assert.ok(blur(host) === 0, msg('…not blended the frame it was allocated (uninitialised)', `${blur(host)}`));
    frame(host);
    assert.ok(blur(host) > 0, msg('…blended from the next frame on', `${blur(host)}`));
    host.simRateController.speedMult = 1;
    frame(host);
    host.simRateController.speedMult = 15;
    frame(host);
    assert.ok(blur(host) === 0, msg('a skipped copy leaves a stale history: not blended on return', `${blur(host)}`));
  });
});

describe('6. focus → overview releases the MSAA set after the hysteresis', () => {
  it('release, destroy, rebind, reallocate, resize', () => {
    const host = mockHost({ tier: 'high' });
    frame(host);
    const bytesBefore = postTargetBytes(Object.fromEntries(host.profiler.tracked));
    const msaaTextures = [...host.device.live].filter((t) => t.sampleCount === 4);
    assert.ok(msaaTextures.length === 3, msg('focus/high: 4× textures exist', `${msaaTextures.length}`));
    assert.ok(msaaTextures.filter((t) => t.format !== 'depth24plus').every((t) => t.usage === GPUTextureUsage.RENDER_ATTACHMENT),
      msg('MSAA colour pair is render-attachment only'));
    host.isOverviewMode = () => true;
    for (let i = 0; i < POST_TARGET_RELEASE_FRAMES; i++) frame(host);
    assert.ok(host._frameGraph.allocatedLifetimes().includes('msaa'), msg('within the hysteresis the MSAA set is kept'));
    frame(host);
    const bytesAfter = postTargetBytes(Object.fromEntries(host.profiler.tracked));
    assert.ok(host._frameGraph.allocatedLifetimes().join() === 'ssr',
      msg('after it, MSAA (and TAA / history) are released', host._frameGraph.allocatedLifetimes().join()));
    assert.ok(msaaTextures.every((t) => t.destroyed), msg('released textures are destroyed'));
    assert.ok(bytesAfter < bytesBefore, msg('postTargetBytes drops', `${bytesBefore} → ${bytesAfter}`));
    assert.ok(host.bloomCompositeBindGroup.entries.find((e) => e.binding === 5).resource.texture.label === 'placeholder-history',
      msg('composite rebound to placeholders'));
    host.isOverviewMode = () => false;
    frame(host);
    assert.ok(host._frameGraph.allocatedLifetimes().includes('msaa'), msg('back to focus: reallocated'));

    // Resize drops every lazy target; the next frame brings back what it uses.
    host.setupDepthBuffer();
    host.setupBloomTextures();
    assert.ok(host._frameGraph.allocatedLifetimes().join() === 'shadow',
      msg('resize: only the (canvas-independent) shadow map is left', host._frameGraph.allocatedLifetimes().join()));
    frame(host);
    assert.ok(host._frameGraph.allocatedLifetimes().sort().join() === 'history,msaa,shadow,ssr,taa',
      msg('resize: next frame reallocates', host._frameGraph.allocatedLifetimes().sort().join()));
  });
});

describe('7. timing', () => {
  it('every encoded GPU pass gets a slot', () => {
    const host = mockHost({ tier: 'high' });
    host.profiler.timingEnabled = true;
    frame(host);
    const timed = host._frameGraphReport.timedPasses.map((t) => t.name).join();
    assert.ok(timed === 'compute,shadow,scene,depth-resolve,taa,ssr,bloom,composite',
      msg('timing: every GPU pass is timed (history is a copy)', timed));
    assert.ok(host.profiler.lastTimed?.join() === timed, msg('timing: profiler got the slot map'));
  });
});

describe('8. lazy tiers + the key-light shadow', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('focus/high: compile, then shadow + MSAA; medium turns the shadow off', async () => {
    const host = mockHost({ tier: 'high', readyTiers: false });
    frame(host);
    assert.ok(!host._frameGraphReport.ran.includes('shadow') && !host._frameGraphReport.ran.includes('depth-resolve'),
      msg('first focus/high frame: no MSAA, no shadow while compiling', host._frameGraphReport.ran.join()));
    assert.ok(['msaa', 'shadow'].every((t) => host.pipelineTiers.state(t) === 'compiling'), msg('…tiers started'));
    await settle();
    frame(host);
    assert.ok(['shadow', 'depth-resolve'].every((p) => host._frameGraphReport.ran.includes(p)),
      msg('after compile: shadow + MSAA run', host._frameGraphReport.ran.join()));
    assert.ok(['device_msaa4', 'sky', 'grid', 'anomaly', 'energyPipe', 'depthResolve'].every((n) => host.compiled.includes(n))
      && host.compiled.filter((n) => n === 'device_msaa4').length === 1,
    msg('msaa tier compiled every 4× variant + depth resolve, once', host.compiled.join()));

    const bench = host.devices.seg;
    assert.ok(bench.log.includes('casters:shadow') && bench.log.at(-1) !== 'variant:shadow'
      && !bench.log.includes('render:shadow'), msg('casters drawn with the depth-only variant, then back to base', bench.log.join()));
    const map = [...host.device.live].find((t) => t.label === 'shadow-map');
    assert.ok(!!map && map.format === 'depth32float'
      && [...host.device.live].filter((t) => t.label === 'shadow-map').length === 1, msg('one 2048² depth32float map'));
    assert.ok((host.profiler.tracked.get('shadowMap') ?? 0) === SHADOW_MAP_SIZE * SHADOW_MAP_SIZE * 4,
      msg('map tracked as a post target'));
    const su = host.device.writes.get('shadow-uniforms');
    assert.ok(su?.[16] === 1 && Math.abs(su[19] - 0.6) < 1e-6,
      msg('receivers see enabled = 1 and strength = lightingConfig.shadowStrength', `${su?.[16]} / ${su?.[19]}`));
    const sceneFrame = host.frameBindings.sceneGroup();
    assert.ok(sceneFrame.entries.find((e) => e.binding === 9).resource.texture === map, msg('scene frame group samples the real map'));
    assert.ok(host.frameBindings.shadowGroup().entries.find((e) => e.binding === 0).resource.buffer.label === 'shadow-caster-uniforms'
      && host.frameBindings.shadowGroup().entries.find((e) => e.binding === 9).resource.texture.label === 'shadow-map-placeholder',
    msg('shadow-pass frame group: light Uniforms + placeholder map'));

    // Medium tier focus: pass off, receivers told so.
    host.profiler.qualityTier = 'medium';
    frame(host);
    assert.ok(!host._frameGraphReport.ran.includes('shadow'), msg('medium: no shadow pass'));
    assert.ok(host.device.writes.get('shadow-uniforms')?.[16] === 0, msg('medium: receivers see enabled = 0'));
  });

  it('overview/high never compiles or runs the shadow', async () => {
    const ov = mockHost({ tier: 'high', overview: true, readyTiers: false });
    frame(ov); await settle(); frame(ov); frame(ov);
    assert.ok(!ov._frameGraphReport.ran.includes('shadow'), msg('overview/high: no shadow pass, ever'));
    assert.ok(ov.pipelineTiers.state('msaa') === 'idle' && ov.pipelineTiers.state('shadow') === 'idle'
      && !ov.compiled.includes('device_msaa4') && !ov.compiled.includes('shadowCasters'),
    msg('overview never compiles MSAA or shadow casters', ov.compiled.join()));
    assert.ok(![...ov.device.live].some((t) => t.label === 'shadow-map'), msg('overview: no shadow map texture'));
  });
});
