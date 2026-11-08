#!/usr/bin/env node
/**
 * #225 §3–§4 CPU-side contracts (no GPU):
 *
 *  1. UniformRing (src/visualizer/uniform-ring.ts): one stable 256 B slot per
 *     (owner, part), distinct owners never alias, overflow throws instead of
 *     wrapping, and a frame is exactly one writeBuffer of the slots in use.
 *  2. fitKeyLightMatrix (src/visualizer/shadow-map.ts): the fitted sphere lands
 *     inside light clip space (x, y ∈ [−1, 1], z ∈ [0, 1]), the target maps to
 *     the centre, nearer-to-light means smaller depth, an overhead key is finite.
 *  3. StaticBundles (src/visualizer/render-bundles.ts): recorded once and
 *     replayed while deps hold; re-recorded on a dep / MSAA / frame-group
 *     change; the frame group is rebound after executeBundles; bundled draws
 *     are counted per replay, not at record time.
 *
 * Usage: node scripts/test-uniform-ring.mjs   (exit 1 on failure)
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// WebGPU enums the bundled pipeline-layout modules read at load time.
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUTextureUsage = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
globalThis.GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, QUERY_RESOLVE: 512 };

const result = await esbuild.build({
  stdin: {
    contents: [
      "export * from './src/visualizer/uniform-ring.ts';",
      "export { fitKeyLightMatrix, SHADOW_MAP_SIZE } from './src/visualizer/shadow-map.ts';",
      "export { StaticBundles } from './src/visualizer/render-bundles.ts';"
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
  define: { 'import.meta.url': '"file:///stub/uniform-ring-test.js"', 'import.meta.env': '{"DEV":true}' }
});
const {
  UniformRing, UNIFORM_SLOT_BYTES, UNIFORM_SLOT_FLOATS, DEFAULT_UNIFORM_SLOTS,
  fitKeyLightMatrix, StaticBundles
} = await import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`);

const failures = [];
let checks = 0;
function check(label, cond, detail = '') {
  checks++;
  if (!cond) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
}

// ── 1. UniformRing ──────────────────────────────────────────────
{
  const writes = [];
  const device = {
    createBuffer: (d) => ({ label: d.label, size: d.size, usage: d.usage, destroy() {} }),
    queue: { writeBuffer: (buffer, offset, data, dataOffset, size) => writes.push({ buffer, offset, data, dataOffset, size }) }
  };
  check('slot = 256 B (max minUniformBufferOffsetAlignment)', UNIFORM_SLOT_BYTES === 256 && UNIFORM_SLOT_FLOATS === 64);
  const big = new UniformRing(device);
  check('default capacity sized in whole slots', big.buffer.size === DEFAULT_UNIFORM_SLOTS * 256);
  check('usage is UNIFORM | COPY_DST', big.buffer.usage === (0x40 | 0x08), `${big.buffer.usage}`);

  const ring = new UniformRing(device, { slots: 4 });
  const a = {}, b = {};
  const a0 = ring.slot(a, 0, 6);
  const a3 = ring.slot(a, 3, 6);
  const b0 = ring.slot(b, 0, 6);
  check('offsets are 256-aligned', [a0, a3, b0].every((o) => o % 256 === 0), `${a0},${a3},${b0}`);
  check('offsets distinct across parts and owners', new Set([a0, a3, b0]).size === 3);
  check('stable: same pair → same offset', ring.slot(a, 3, 6) === a3 && ring.offsetOf(a, 3) === a3);
  check('offsetOf never allocates', ring.offsetOf(a, 1) === -1 && ring.slotsUsed === 3);
  check('partsOf maps part → slot index', [...ring.partsOf(a)].join() === '0,-1,-1,1,-1,-1');
  let range = null;
  try { ring.slot(a, 6, 6); } catch (e) { range = e; }
  check('part outside the owner table throws', range instanceof RangeError);
  ring.slot(b, 1, 6);
  let overflow = null;
  try { ring.slot(b, 2, 6); } catch (e) { overflow = e; }
  check('overflow throws instead of aliasing a slot', overflow instanceof RangeError && ring.slotsUsed === 4);

  ring.f32[UniformRing.base(a3)] = 2;
  ring.f32[UniformRing.base(b0) + 11] = 7;
  writes.length = 0;
  ring.flush();
  check('one writeBuffer per frame', writes.length === 1 && ring.writes === 1, `${writes.length}`);
  check('…covering exactly the slots in use from offset 0',
    writes[0].offset === 0 && writes[0].dataOffset === 0 && writes[0].size === 4 * 256, JSON.stringify({ ...writes[0], data: undefined, buffer: undefined }));
  const view = new Float32Array(writes[0].data);
  check('…carrying the in-place packed values', view[a3 / 4] === 2 && view[b0 / 4 + 11] === 7);

  const empty = new UniformRing(device, { slots: 2 });
  writes.length = 0;
  empty.flush();
  check('nothing in use → no write', writes.length === 0 && empty.writes === 0);
}

// ── 2. fitKeyLightMatrix ────────────────────────────────────────
function xform(m, p) {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, z / w, w];
}
for (const [label, key] of [['preset key', [6, 9, 7]], ['low grazing key', [10, 1.5, -3]], ['overhead key', [0, 10, 0]]]) {
  const len = Math.hypot(...key);
  const toLight = key.map((k) => k / len);
  const target = [1, 1, -2];
  const radius = 8.5;
  const m = fitKeyLightMatrix({ toLight, target, radius });
  check(`${label}: finite`, [...m].every(Number.isFinite));
  const c = xform(m, target);
  check(`${label}: target at the centre`, Math.abs(c[0]) < 1e-5 && Math.abs(c[1]) < 1e-5 && c[2] > 0 && c[2] < 1,
    c.map((v) => v.toFixed(4)).join());
  check(`${label}: orthographic (w = 1)`, Math.abs(c[3] - 1) < 1e-6);
  let inside = true;
  for (let i = 0; i < 200; i++) {
    // Deterministic points on the sphere (Fibonacci).
    const t = (i + 0.5) / 200;
    const phi = Math.acos(1 - 2 * t), th = Math.PI * (1 + Math.sqrt(5)) * i;
    const p = [target[0] + radius * Math.sin(phi) * Math.cos(th), target[1] + radius * Math.cos(phi),
      target[2] + radius * Math.sin(phi) * Math.sin(th)];
    const q = xform(m, p);
    if (Math.abs(q[0]) > 1 + 1e-5 || Math.abs(q[1]) > 1 + 1e-5 || q[2] < 0 || q[2] > 1) { inside = false; break; }
  }
  check(`${label}: fitted sphere inside light clip space`, inside);
  const near = xform(m, target.map((v, i) => v + toLight[i] * radius * 0.5));
  const far = xform(m, target.map((v, i) => v - toLight[i] * radius * 0.5));
  check(`${label}: nearer the light → smaller depth`, near[2] < c[2] && c[2] < far[2]);
}

// ── 3. StaticBundles ────────────────────────────────────────────
{
  const encoders = [];
  let drawCount = 0;
  const host = {
    frameBindings: { group: { label: 'frame-a' }, sceneGroup() { return this.group; } },
    pipelineCache: { sceneFormat: 'rgba16float', depthFormat: 'depth24plus' },
    profiler: { recordDraw(n = 1) { drawCount += n; } },
    device: {
      createRenderBundleEncoder(desc) {
        const log = [];
        const enc = {
          desc, log,
          setBindGroup: (i, g) => log.push(`bg${i}:${g.label}`),
          setPipeline: () => log.push('pipeline'),
          draw: () => log.push('draw'),
          finish: (d) => ({ label: d.label, desc })
        };
        encoders.push(enc);
        return enc;
      }
    }
  };
  const bundles = new StaticBundles(host);
  const passLog = [];
  const pass = {
    executeBundles: (list) => passLog.push(`exec:${list.map((x) => x.label).join()}`),
    setBindGroup: (i, g) => passLog.push(`bg${i}:${g.label}`)
  };
  const record = (enc) => { enc.setPipeline(); enc.draw(); host.profiler.recordDraw(3); };

  check('no pass shape → caller draws immediately', bundles.replay(pass, 'env', ['p'], record) === false && encoders.length === 0);
  bundles.shape = { msaa: false, gbuffer: true };
  drawCount = 0;
  check('first replay records', bundles.replay(pass, 'env', ['p'], record) && bundles.records === 1);
  check('bundle binds the frame group first', encoders[0].log[0] === 'bg0:frame-a', encoders[0].log.join());
  check('bundle formats follow the pass: scene + G-buffer, 1×',
    encoders[0].desc.colorFormats.length === 2 && encoders[0].desc.sampleCount === 1
    && encoders[0].desc.depthStencilFormat === 'depth24plus');
  check('draws counted on replay, not at record', drawCount === 3, `${drawCount}`);
  bundles.replay(pass, 'env', ['p'], record);
  check('same deps → replay without re-record', bundles.records === 1 && bundles.replays === 2 && drawCount === 6);
  check('frame group rebound after every executeBundles',
    passLog.join() === 'exec:bundle:env,bg0:frame-a,exec:bundle:env,bg0:frame-a', passLog.join());
  bundles.replay(pass, 'env', ['p2'], record);
  check('dep identity change → re-record', bundles.records === 2);
  bundles.shape = { msaa: true, gbuffer: true };
  bundles.replay(pass, 'env', ['p2'], record);
  check('MSAA change → re-record at 4×', bundles.records === 3 && encoders.at(-1).desc.sampleCount === 4);
  host.frameBindings.group = { label: 'frame-b' };
  bundles.replay(pass, 'env', ['p2'], record);
  check('frame group change (shadow map allocated) → re-record', bundles.records === 4
    && encoders.at(-1).log[0] === 'bg0:frame-b');
  check('names() lists cached bundles', bundles.names().join() === 'env');
}

if (failures.length) {
  console.error(`[uniform-ring] ${failures.length}/${checks} checks failed:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`[uniform-ring] ${checks} checks passed (ring, light fit, render bundles)`);
