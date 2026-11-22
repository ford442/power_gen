/**
 * test:gpu-golden — overview-cull-compute.wgsl vs a CPU frustum test (#258 §3).
 *
 * The GPU side is the app's own `OverviewCullPass` (slot packing, uniforms,
 * dispatch) on the `overviewCull` pipeline; the view-projection matrix comes
 * from `MultiDeviceCamera`'s own perspective / lookAt. The reference does not
 * touch that matrix: it builds the six frustum planes from the camera's
 * position, target, field of view, aspect and clip distances, and tests each
 * device's bounding sphere in double precision. So a wrong row/column
 * convention, a wrong depth range or a mis-packed struct shows up as a
 * device drawn that should be culled (or the reverse).
 *
 * Exact: instance counts are integers. Each scenario is checked to keep every
 * sphere at least 1e-3 world units off a plane, so f32 vs f64 cannot flip a
 * result.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gpuSkip, nodeGpu, readBuffer } from '../../lib/node-gpu.mjs';
import { gpuSession } from '../../lib/gpu-app.mjs';

const gpu = await nodeGpu();
const skip = gpuSkip(gpu);
const session = skip ? null : await gpuSession(gpu, { label: 'golden-cull' });

const NEAR = 0.1;
const FAR = 200;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const add = (a, b, s = 1) => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];

/** Smallest signed distance of a point to the frustum's six inward planes. */
function frustumDistance(cam, p) {
  const f = norm(sub(cam.target, cam.position));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const tanV = Math.tan((cam.fov * Math.PI) / 360);
  const tanH = tanV * cam.aspect;
  const v = sub(p, cam.position);
  const depth = dot(f, v);
  return Math.min(
    depth - NEAR,
    FAR - depth,
    dot(norm(add(r, f, tanH)), v),
    dot(norm(add([-r[0], -r[1], -r[2]], f, tanH)), v),
    dot(norm(add(u, f, tanV)), v),
    dot(norm(add([-u[0], -u[1], -u[2]], f, tanV)), v)
  );
}

function viewProj(app, cam) {
  const C = app.MultiDeviceCamera.prototype;
  const proj = C.perspectiveMatrix((cam.fov * Math.PI) / 180, cam.aspect, NEAR, FAR);
  const view = C.lookAt.call(C, cam.position, cam.target, [0, 1, 0]);
  return C.multiplyMatrices(proj, view);
}

/** The pass's buffers have no COPY_SRC (nothing reads them back in the app). */
function readable(device) {
  const create = device.createBuffer.bind(device);
  return (desc) => create({ ...desc, usage: desc.usage | GPUBufferUsage.COPY_SRC });
}

/**
 * 16 catalog benches on the overview ring (their 16-unit spheres nearly
 * always intersect the frustum, as in the app), stragglers well outside it,
 * and small probe spheres scattered through the volume so every plane of
 * every camera has spheres on both sides. 32 slots = the pass's capacity.
 */
function scene(app) {
  const ids = app.DEVICE_CATALOG.map((d) => d.id);
  const devices = ids.map((id, i) => {
    const a = (i / ids.length) * Math.PI * 2;
    return { id, position: [Math.cos(a) * 20, 0, Math.sin(a) * 20], particleCount: 4000 + i * 517, config: { plugin: i >= 6 } };
  });
  devices.push({ id: 'far-behind', position: [0, 0, 400], particleCount: 9000, config: { cullRadius: 6 } });
  devices.push({ id: 'far-above', position: [0, 300, 0], particleCount: 9000, config: { cullRadius: 6 } });
  devices.push({ id: 'tiny-near-origin', position: [0.5, 1, -0.5], particleCount: 777, config: { cullRadius: 1 } });
  let s = 0x9e3779b9;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; devices.length < 32; i++) {
    devices.push({
      id: `probe-${i}`,
      position: [(rnd() - 0.5) * 110, (rnd() - 0.3) * 50, (rnd() - 0.5) * 110],
      particleCount: 1000 + i,
      config: { cullRadius: 1.5 }
    });
  }
  return devices;
}

const CAMERAS = [
  { name: 'overview orbit', position: [0, 28, 62], target: [0, 0, 0], fov: 45, aspect: 1.6 },
  { name: 'low and close, half the ring behind', position: [6, 4, 9], target: [20, 0, 0], fov: 45, aspect: 1.6 },
  { name: 'portrait phone', position: [0, 18, 44], target: [0, 2, 0], fov: 60, aspect: 0.5 },
  { name: 'looking away from the lab', position: [0, 10, 40], target: [0, 10, 120], fov: 45, aspect: 1.6 },
  { name: 'inside the ring, looking out', position: [0, 3, 0], target: [20, 1, 5], fov: 70, aspect: 2.2 }
];

describe('gpu-golden: overview-cull-compute.wgsl vs a CPU sphere / frustum test', { skip }, () => {
  for (const cam of CAMERAS) {
    for (const quality of [1, 0.5]) {
      it(`${cam.name} (quality ${quality}): draw-indirect args exact`, async () => {
        const { app, device, cache, shaders } = session;
        const create = device.createBuffer;
        device.createBuffer = readable(device);
        const pass = new app.cull.OverviewCullPass(device, { pipelineCache: cache });
        try {
          assert.ok(pass.init(await cache.ensureOverviewCullPipeline(shaders)));
        } finally {
          device.createBuffer = create;
        }
        const devices = scene(app);
        const margin = 1.35;
        // Every third bench is switched off: enabled → flags bit 0.
        const isEnabled = (d) => devices.indexOf(d) % 3 !== 1;
        const n = pass.update({
          devices, cameraPos: cam.position, currentView: 'overview', qualityLevel: quality, qualityTier: 'high',
          viewProj: viewProj(app, cam), margin, isEnabled
        });
        assert.equal(n, devices.length);

        const enc = device.createCommandEncoder();
        const cp = enc.beginComputePass();
        assert.ok(pass.dispatch(cp));
        cp.end();
        device.queue.submit([enc.finish()]);
        const args = new Uint32Array(await readBuffer(device, pass.drawArgsBuffer, 0, n * app.cull.DRAW_ARGS_STRIDE));
        const out = new Uint32Array(await readBuffer(device, pass.outputBuffer));
        assert.deepEqual(device.uncaptured, [], 'GPU validation errors');

        const expected = pass.slots.map((slot) => {
          const reach = slot.radius * Math.max(1, margin);
          const d = frustumDistance(cam, slot.position) + reach;
          assert.ok(Math.abs(d) > 1e-3, `scenario too close to call: ${slot.id} is ${d} from a frustum plane`);
          return d > 0 ? app.cull.expectedInstanceCount(slot) : 0;
        });
        const got = pass.slots.map((_, i) => args[i * 4 + 1]);
        assert.deepEqual(got, expected, `instance counts per slot (${pass.slots.map((s) => s.id).join(', ')})`);
        for (let i = 0; i < n; i++) {
          assert.deepEqual([args[i * 4], args[i * 4 + 2], args[i * 4 + 3]], [app.cull.PARTICLE_VERTEX_COUNT, 0, 0], `slot ${i}: vertexCount / firstVertex / firstInstance`);
        }
        const visible = expected.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);
        assert.equal(out[0], visible.length, 'CullOutput.visibleCount');
        assert.equal(out[1], expected.reduce((a, b) => a + b, 0), 'CullOutput.drawnInstances');
        // Compaction order is whichever thread's atomicAdd lands first.
        assert.deepEqual([...out.subarray(4, 4 + visible.length)].sort((a, b) => a - b), visible, 'CullOutput.indices');
        // A scenario that culls nothing or everything proves little.
        const culled = pass.slots.filter((s, i) => s.enabled && expected[i] === 0).length;
        console.log(`  ${visible.length} drawn, ${culled} culled by the frustum, ${pass.slots.filter((s) => !s.enabled).length} disabled`);
        pass.destroy();
      });
    }
  }

  it('the scenarios cover both outcomes', () => {
    const { app } = session;
    const devices = scene(app);
    let inside = 0;
    let outside = 0;
    for (const cam of CAMERAS) {
      for (const d of devices) {
        const reach = (d.config?.cullRadius ?? 16) * 1.35;
        if (frustumDistance(cam, d.position) + reach > 0) inside++; else outside++;
      }
    }
    assert.ok(inside >= 40 && outside >= 40, `need both visible and culled spheres (visible ${inside}, culled ${outside})`);
  });
});
