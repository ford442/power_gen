/**
 * device-draws — WebGPU draws that silently never happened (#251 follow-ups),
 * on a mock encoder — the real modules, no GPU:
 *
 *  1. Transformer flux: DevicePipelineManager gives every bench the
 *     fluxSegment pipeline (was SEG-only), and the transformer plugin's
 *     drawWebgpu encodes draw(4, fluxTotalSegments).
 *  2. Pickup coils: ringPipeline is the segEnhanced pipeline (was always
 *     null), renderPickupCoils draws both connection rings in one instanced
 *     call and 24 coils from the pickup mesh; the coil instances are packed in
 *     coil-vert.wgsl's CoilInstance layout (angle, energy, index — the old
 *     quaternion packing fed sin(θ/2) in as the intensity).
 *  3. BindGroupCache rebuilds a group when the buffer under its key changes
 *     (focus-only glTF props are destroyed on leaving SEG and re-uploaded:
 *     "Buffer used in submit while destroyed" every frame after a return).
 *  4. Camera matrices are per-camera scratch (no per-frame Float32Array) and
 *     still equal the freshly built product.
 *  5. roller-frag shades its key light from the preset direction (the one the
 *     shadow map is fitted along), not a fixed (1,1,1).
 *
 * Usage: npm run test:device-draws   (node --test scripts/tests/device-draws.test.mjs)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { ROOT, bundleTs } from '../test-harness.mjs';

globalThis.GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

const {
  DevicePipelineManager, DeviceRenderMixin, transformerPlugin, segUpdatePickupCoilEnergies,
  BindGroupCache, MultiDeviceCamera
} = await bundleTs({
  contents: [
    "export { DevicePipelineManager } from './src/device-pipeline-manager.ts';",
    "export { DeviceRenderMixin, DEVICE_PART } from './src/devices/device-render.ts';",
    "export { transformerPlugin } from './src/devices/quanta/transformer.ts';",
    "export { segUpdatePickupCoilEnergies } from './src/devices/core/seg-update.ts';",
    "export { BindGroupCache } from './src/renderers/shared/bind-group-cache.ts';",
    "export { MultiDeviceCamera } from './src/multi-device-camera.ts';"
  ].join('\n'),
  sourcefile: 'device-draws-entry.ts'
});

/** Records pipeline + draw calls the way a GPURenderPassEncoder would see them. */
function mockPass() {
  const calls = [];
  let pipeline = null;
  return {
    calls,
    draws: () => calls.filter((c) => c.op === 'draw' || c.op === 'drawIndexed'),
    setPipeline(p) { pipeline = p; calls.push({ op: 'setPipeline', p }); },
    setBindGroup(i, bg, offs) { calls.push({ op: 'setBindGroup', i, bg, offs }); },
    setVertexBuffer(slot, b) { calls.push({ op: 'setVertexBuffer', b }); },
    setIndexBuffer(b) { calls.push({ op: 'setIndexBuffer', b }); },
    draw(count, inst = 1) { calls.push({ op: 'draw', pipeline, count, inst }); },
    drawIndexed(count, inst = 1) { calls.push({ op: 'drawIndexed', pipeline, count, inst }); }
  };
}

/** Pipeline cache that only knows the base + shadow variants it is told about. */
function mockPipelineCache(names) {
  const map = new Map(names.map((n) => [n, { label: n }]));
  return {
    getPipeline: (n) => map.get(n) ?? null,
    getParticleComputePipeline: () => ({ label: 'particleCompute' }),
    createBindGroup: (layout, entries, label) => ({ layout, entries, label })
  };
}
const BASE = ['roller', 'particle', 'coil', 'fluxSegment', 'energyArc', 'segEnhanced', 'fieldLine', 'roller_shadow', 'segEnhanced_shadow'];

describe('transformer flux', () => {
  let pm;
  before(async () => {
    pm = new DevicePipelineManager({}, 'transformer', { pipelineCache: mockPipelineCache(BASE) });
    await pm.setupPipelines();
  });

  it('fluxSegmentPipeline is the fluxSegment pipeline', () => {
    assert.ok(pm.fluxSegmentPipeline?.label === 'fluxSegment', `got ${pm.fluxSegmentPipeline?.label}`);
  });

  it('no flux pipeline in the shadow pass (no caster variant)', () => {
    pm.applyPassVariant('shadow');
    assert.equal(pm.fluxSegmentPipeline, null);
    pm.applyPassVariant('base');
  });

  it('drawWebgpu encodes one draw(4, 1152) on fluxSegment', () => {
    const instance = {
      fluxSegmentRenderBindGroup: { label: 'flux-bg' },
      pipelineManager: pm,
      fieldLineEnabled: true,
      geometry: { fluxTotalSegments: 1152 },
      visualizer: { profiler: { qualityLevel: 1 } },
      _deviceUniformOffset: () => 0
    };
    const pass = mockPass();
    transformerPlugin.drawWebgpu(instance, pass, false);
    const d = pass.draws();
    assert.ok(d.length === 1, `drawWebgpu encodes one flux draw — draws ${JSON.stringify(d)}`);
    assert.ok(d[0]?.op === 'draw' && d[0].count === 4 && d[0].inst === 1152 && d[0].pipeline?.label === 'fluxSegment',
      `flux draw is draw(4, 1152) on fluxSegment — ${JSON.stringify(d[0])}`);
  });
});

describe('pickup coils + connection rings', () => {
  let pm;
  before(async () => {
    pm = new DevicePipelineManager({}, 'seg', { pipelineCache: mockPipelineCache(BASE) });
    await pm.setupPipelines();
  });

  it('ringPipeline is the segEnhanced pipeline; fluxSegmentPipeline still set', () => {
    assert.ok(pm.ringPipeline?.label === 'segEnhanced', `ringPipeline: got ${pm.ringPipeline?.label}`);
    assert.ok(pm.fluxSegmentPipeline?.label === 'fluxSegment', 'fluxSegmentPipeline still set');
  });

  it('renderPickupCoils draws rings (one instanced call) and 24 coils, both on the rollers slot', () => {
    const offsets = [];
    const instance = {
      id: 'seg',
      coilInstances: { label: 'coil-instances' },
      coilMaterialBuffer: { label: 'coil-mat' },
      ringMaterialBuffer: { label: 'ring-mat' },
      get coilPipeline() { return pm.coilPipeline; },
      get ringPipeline() { return pm.ringPipeline; },
      visualizer: {
        connectionRingBuffer: { vertexBuffer: {}, indexBuffer: {}, indexCount: 576 },
        connectionRingInstances: { label: 'ring-instances' },
        pickupCoilBuffer: { vertexBuffer: { label: 'pickup-vb' }, indexBuffer: {}, indexCount: 432 }
      },
      _cacheBg: (key, layout, entries) => ({ key, layout, entries }),
      _deviceUniformResource: () => ({ buffer: {} }),
      _deviceUniformOffset: (part) => { offsets.push(part); return part * 256; }
    };
    const pass = mockPass();
    DeviceRenderMixin.renderPickupCoils.call(instance, pass);
    const d = pass.draws();
    const rings = d.find((c) => c.count === 576);
    const coils = d.find((c) => c.count === 432);
    assert.ok(d.length === 2, `renderPickupCoils draws (no early return) — draws ${JSON.stringify(d)}`);
    assert.ok(rings?.op === 'drawIndexed' && rings.inst === 2 && rings.pipeline?.label === 'segEnhanced',
      `both connection rings in one drawIndexed(…, 2) on segEnhanced — ${JSON.stringify(rings)}`);
    assert.ok(coils?.op === 'drawIndexed' && coils.inst === 24 && coils.pipeline?.label === 'coil',
      `24 pickup coils, drawIndexed on the coil pipeline — ${JSON.stringify(coils)}`);
    assert.ok(offsets.length === 2 && offsets.every((p) => p === 0),
      `rings and coils both use the rollers slot (ring y lives in the instances) — ${JSON.stringify(offsets)}`);
  });

  // Instance packing (seg-update.ts) — what coil-vert.wgsl reads.
  it('pickup instances are packed in the CoilInstance layout (angle, energy, index)', () => {
    let written = null;
    const rollerXZ = new Float32Array(36 * 2);
    for (let r = 0; r < 36; r++) { rollerXZ[r * 2] = 7; rollerXZ[r * 2 + 1] = 0; }
    const seg = {
      coilInstances: {},
      coilEnergies: null,
      arcSegments: null,
      device: { queue: { writeBuffer: (buf, off, data) => { written = Float32Array.from(data); } } }
    };
    segUpdatePickupCoilEnergies(seg, rollerXZ, true);
    assert.ok(written?.length === 24 * 8, `pickup instances written (24 × 8 floats) — len ${written?.length}`);
    const i = 6;
    const angle = (i / 24) * Math.PI * 2;
    assert.ok(Math.abs(written[i * 8 + 3] - (angle + Math.PI)) < 1e-5, `coil instance [3] is the yaw angle — ${written[i * 8 + 3]}`);
    assert.ok(Math.abs(written[i * 8 + 4] - seg.coilEnergies[i]) < 1e-6, 'coil instance [4] is the coil energy');
    assert.ok(written[i * 8 + 5] === i, 'coil instance [5] is the coil index');
    assert.ok(written[4] > 0, `coil 0 (next to a roller) carries energy — ${written[4]}`);
  });
});

describe('BindGroupCache token', () => {
  it('caches per token, rebuilds on a new buffer, untokened keys still cache', () => {
    const cache = new BindGroupCache();
    let made = 0;
    const factory = () => ({ n: ++made });
    const bufA = {};
    const bufB = {};
    const a1 = cache.get('gltf:housing', factory, bufA);
    const a2 = cache.get('gltf:housing', factory, bufA);
    const b1 = cache.get('gltf:housing', factory, bufB);
    assert.ok(a1 === a2 && made === 2, 'same token → cached group');
    assert.ok(b1 !== a1 && b1.n === 2, 'new buffer under the same key → rebuilt group');
    assert.ok(cache.get('k', factory) === cache.get('k', factory), 'untokened keys still cache');
  });
});

describe('camera scratch', () => {
  it('getViewProjMatrix reuses one array that equals the fresh product and inverts to I', () => {
    const cam = new MultiDeviceCamera({ width: 1280, height: 720 }, { fov: 45, position: [3, 4, 9], target: [0, 0.5, 0] }, {});
    const vp1 = cam.getViewProjMatrix();
    const fresh = cam.multiplyMatrices(
      cam.perspectiveMatrix(45 * Math.PI / 180, 1280 / 720, 0.1, 200),
      cam.lookAt([3, 4, 9], [0, 0.5, 0], [0, 1, 0])
    );
    const snapshot = Float32Array.from(vp1);
    const vp2 = cam.getViewProjMatrix();
    assert.ok(vp1 === vp2, 'getViewProjMatrix reuses one array');
    assert.ok(fresh.every((x, i) => Math.abs(x - snapshot[i]) < 1e-6), 'scratch result equals the fresh product');
    const inv = cam.invertMatrix(vp2);
    const id = cam.multiplyMatrices(Float32Array.from(inv), Float32Array.from(vp2));
    assert.ok(id.every((x, i) => Math.abs(x - (i % 5 === 0 ? 1 : 0)) < 1e-4), 'invertMatrix(viewProj) · viewProj = I');
  });
});

describe('roller-frag key light', () => {
  const src = readFileSync(join(ROOT, 'src/shaders/passes/roller-frag.wgsl'), 'utf8');
  it('key light from lighting.key.posOrDir', () => {
    assert.match(src, /let L1 = normalize\(lighting\.key\.posOrDir\)/);
  });
  it('binds the frame lighting uniform (binding 5)', () => {
    assert.match(src, /@binding\(5\) @group\(0\) var<uniform> lighting: LightingConfig/);
  });
});
