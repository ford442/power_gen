/**
 * test:gpu-golden — the screen-space liquid surface on a real GPU (ADR-0022,
 * docs/FLUIDS.md → The surface).
 *
 * Runs the app's own `FluidSurfacePass` (its pipelines, targets and bind
 * groups) against a stand-in host: a camera at the origin looking down −z, a
 * scene colour target, a scene depth target and a frame group. The three
 * steps are run one at a time and their targets read back:
 *
 *   splat      a sphere's depth is its centre distance minus its radius, its
 *              disc the size the projection says; spray and empty records
 *              draw nothing; summed thickness is the particle's volume
 *   filter     the two WGSL passes against the CPU twin, texel for texel
 *   composite  pixels without liquid are untouched, to the bit; liquid in
 *              front of the scene changes them; liquid behind the scene does
 *              not; a thicker liquid absorbs more red than blue
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gpuSkip, nodeGpu, readTexture } from '../../lib/node-gpu.mjs';
import { gpuSession } from '../../lib/gpu-app.mjs';

const gpu = await nodeGpu();
const skip = gpuSkip(gpu);
// Top level: nodeDevice() destroys the device when the enclosing scope ends.
const session = skip ? null : await gpuSession(gpu, { label: 'golden-fluid-surface' });

const W = 256, H = 192;
const Z_FAR = 200;
const FOV_DEG = 45;
const PROJ_Y = 1 / Math.tan((FOV_DEG * Math.PI) / 360);

/** The app's projection (multi-device-camera.ts `perspectiveMatrix`), column-major. */
function perspective() {
  const nf = 1 / (0.1 - Z_FAR);
  const m = new Float32Array(16);
  m[0] = PROJ_Y / (W / H); m[5] = PROJ_Y; m[10] = (Z_FAR + 0.1) * nf; m[11] = -1; m[14] = 2 * Z_FAR * 0.1 * nf;
  return m;
}
const PROJ = perspective();
const VIEW = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Half-float bits → number. */
function half(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

/** An unsigned small float of rg11b10ufloat: 5 exponent bits over `mantissaBits`. */
function ufloat(bits, mantissaBits) {
  const e = bits >> mantissaBits, m = bits & ((1 << mantissaBits) - 1), one = 1 << mantissaBits;
  if (e === 0) return (m / one) * 2 ** -14;
  if (e === 31) return m ? NaN : Infinity;
  return (1 + m / one) * 2 ** (e - 15);
}

/** A host with exactly what the pass reads, and the handles the tests use. */
function makeRig({ sceneDistance = null, look = 'studio' } = {}) {
  const { app, device, cache } = session;
  const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
  const sceneColor = device.createTexture({ label: 'test-scene-color', size: [W, H], format: cache.sceneFormat, usage });
  const sceneDepth = device.createTexture({ label: 'test-scene-depth', size: [W, H], format: cache.depthFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  // Frame group: lighting with a key light and no baked IBL (the analytic
  // environment), placeholders for everything the composite does not read.
  const buffer = (bytes, kind) => device.createBuffer({ size: bytes, usage: kind | GPUBufferUsage.COPY_DST });
  const lighting = new Float32Array(36);
  lighting.set([0.4, 0.8, 0.45, 0, 1, 0.97, 0.92, 1.35], 0);   // key: direction, colour, intensity
  lighting.set([-0.5, 0.4, 0.6, 0, 0.7, 0.8, 1, 0.5], 8);       // fill
  lighting.set([0, 0.3, -1, 0, 1, 1, 1, 0.4], 16);              // rim
  lighting.set([0, -1, 0, 0, 0.3, 0.3, 0.32, 0.3], 24);         // ground
  lighting.set([0.12, 1, 0.5, 0], 32);                          // ambient, envMapStrength, shadowStrength, iblLevels
  const lightingBuffer = buffer(256, GPUBufferUsage.UNIFORM);
  device.queue.writeBuffer(lightingBuffer, 0, lighting);
  const ibl = device.createTexture({ size: [4, 4, 7], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING });
  const shadow = device.createTexture({ size: [4, 4], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
  const linear = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const frameGroup = cache.createBindGroup('frame', [
    { binding: 0, resource: { buffer: buffer(256, GPUBufferUsage.UNIFORM) } },
    { binding: 4, resource: { buffer: buffer(256, GPUBufferUsage.UNIFORM) } },
    { binding: 5, resource: { buffer: lightingBuffer } },
    { binding: 6, resource: { buffer: buffer(256, GPUBufferUsage.STORAGE) } },
    { binding: 7, resource: ibl.createView({ dimension: '2d-array' }) },
    { binding: 8, resource: linear },
    { binding: 9, resource: shadow.createView({ aspect: 'depth-only' }) },
    { binding: 10, resource: device.createSampler({ compare: 'less' }) },
    { binding: 11, resource: { buffer: buffer(256, GPUBufferUsage.UNIFORM) } }
  ], 'test-frame-bg');

  const host = {
    pipelineCache: cache,
    cameraController: { getViewProjMatrix: () => PROJ, getViewMatrix: () => VIEW, getProjMatrix: () => PROJ },
    bloomSceneTexture: sceneColor,
    bloomSampler: linear,
    depthSampleView: sceneDepth.createView({ aspect: 'depth-only' }),
    depthResolvedSampleView: null,
    frameBindings: { sceneGroup: () => frameGroup },
    lightingLook: look,
    profiler: null
  };
  const pass = new app.FluidSurfacePass(device, host);

  /** Clear the scene: a flat colour, and a depth as if an opaque wall stood `sceneDistance` away (null = nothing). */
  const BACKDROP = { r: 0.5, g: 0.4, b: 0.3, a: 1 };
  const clearScene = () => {
    const depth = sceneDistance === null ? 1 : app.fluidSurface.fluidSceneDepth(sceneDistance, PROJ);
    const enc = device.createCommandEncoder();
    enc.beginRenderPass({
      colorAttachments: [{ view: sceneColor.createView(), clearValue: BACKDROP, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: sceneDepth.createView(), depthClearValue: depth, depthLoadOp: 'clear', depthStoreOp: 'store' }
    }).end();
    device.queue.submit([enc.finish()]);
  };

  /** Draw records: [x, y, z, effect type] per particle. */
  const records = (list) => {
    const data = new Float32Array(list.length * 4);
    list.forEach((p, i) => data.set([p[0], p[1], p[2], p[3] + 0.25], i * 4));
    const buf = device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buf, 0, data);
    return { buffer: buf, count: list.length };
  };

  const readDepth = async (texture) => new Float32Array((await readTexture(device, texture, { bytesPerPixel: 4 })).data.buffer);
  const readThickness = async (texture) => {
    const raw = new Uint16Array((await readTexture(device, texture, { bytesPerPixel: 2 })).data.buffer);
    return Float32Array.from(raw, half);
  };
  /** The scene colour as RGB floats (3 per pixel), whatever the scene format of this colour mode. */
  const readColor = async () => {
    const format = cache.sceneFormat;
    const out = new Float32Array(W * H * 3);
    if (format === 'rg11b10ufloat') {
      const words = new Uint32Array((await readTexture(device, sceneColor, { bytesPerPixel: 4 })).data.buffer);
      for (let i = 0; i < W * H; i++) {
        out[i * 3] = ufloat(words[i] & 0x7ff, 6);
        out[i * 3 + 1] = ufloat((words[i] >>> 11) & 0x7ff, 6);
        out[i * 3 + 2] = ufloat(words[i] >>> 22, 5);
      }
    } else if (format === 'rgba16float') {
      const halves = new Uint16Array((await readTexture(device, sceneColor, { bytesPerPixel: 8 })).data.buffer);
      for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = half(halves[i * 4 + c]);
    } else {
      throw new Error(`readColor: scene format ${format} is not one this test decodes`);
    }
    return out;
  };
  return { app, device, pass, host, clearScene, records, readDepth, readThickness, readColor, BACKDROP };
}

const GEOMETRY = { radius: 0.2, thicknessScale: 0.25, filterRadius: 0.5, filterRange: 0.6, edgeThickness: 0.05 };
const drawOf = (records, geometry = GEOMETRY, metresPerUnit = 0.64) => ({ ...records, origin: [0, 0, 0], geometry, metresPerUnit });
/** World area one pixel covers at `distance`. */
const pixelArea = (distance) => ((2 * distance) / (H * PROJ_Y)) ** 2;

describe('gpu-golden: screen-space liquid surface', { skip }, () => {
  it('splat: a sphere\'s depth, its disc and its volume; spray and empty records draw nothing', async () => {
    const rig = makeRig();
    assert.ok(await rig.pass.init());
    const { SURFACE, SPRAY, LIQUID } = { SURFACE: 11, SPRAY: 10, LIQUID: 9 };
    const d = 4;
    const drawn = rig.records([
      [0, 0, -d, SURFACE],
      [0.9, 0.5, -d, SPRAY],      // the particle pipeline's, not the surface's
      [-0.9, 0.5, -d, LIQUID],
      [0, -1e6, 0, LIQUID]        // an empty slot
    ]);
    rig.clearScene();
    const frame = rig.pass.prepare(drawOf(drawn), false);
    assert.ok(frame, 'the pass could not prepare');
    const enc = rig.device.createCommandEncoder();
    rig.pass.encodeSplat(enc, frame);
    rig.device.queue.submit([enc.finish()]);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');

    const depth = await rig.readDepth(rig.pass.textures.depth);
    const thickness = await rig.readThickness(rig.pass.textures.thickness);
    const r = GEOMETRY.radius;
    // The pixel beside the axis: half a pixel off the sphere's nearest point.
    const centre = depth[(H / 2) * W + W / 2] * Z_FAR;
    assert.ok(Math.abs(centre - (d - r)) < 2e-3 * r, `front of the sphere at ${centre}, expected ${d - r}`);
    // The disc: every covered pixel, and only the one sphere's.
    const radiusPx = (r * 0.5 * H * PROJ_Y) / d;
    let covered = 0, minX = W, maxX = 0, volume = 0, deepest = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (depth[i] < 0.999) {
          covered++;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          const z = depth[i] * Z_FAR;
          assert.ok(z >= d - r - 1e-3 && z <= d + 1e-3, `pixel ${x},${y} at depth ${z}`);
        }
        volume += thickness[i] * pixelArea(d);
        deepest = Math.max(deepest, thickness[i]);
      }
    }
    assert.ok(Math.abs(covered / (Math.PI * radiusPx ** 2) - 1) < 0.04, `${covered} pixels covered; a disc of radius ${radiusPx.toFixed(2)} px is ${(Math.PI * radiusPx ** 2).toFixed(0)}`);
    assert.ok(Math.abs((maxX - minX + 1) / (2 * radiusPx) - 1) < 0.06, `disc ${maxX - minX + 1} px wide`);
    assert.ok(Math.abs((minX + maxX + 1) / 2 - W / 2) <= 1, 'the disc is not centred: spray or plain records were splatted');
    // Thickness: the chord through the middle, and the volume it adds up to.
    assert.ok(Math.abs(deepest / (2 * r * GEOMETRY.thicknessScale) - 1) < 0.01, `deepest chord ${deepest}`);
    const particleVolume = GEOMETRY.thicknessScale * (4 / 3) * Math.PI * r ** 3;
    assert.ok(Math.abs(volume / particleVolume - 1) < 0.03, `thickness sums to ${volume}; the particle's volume is ${particleVolume}`);
    console.log(`  splat: front ${centre.toFixed(4)} (expected ${(d - r).toFixed(4)}), ${covered} px, volume ${(volume / particleVolume).toFixed(4)} of the particle's`);
    rig.pass.destroy();
  });

  it('splat: far away a sphere is held at a visible size and still stands for its volume', async () => {
    const rig = makeRig();
    assert.ok(await rig.pass.init());
    const geometry = { ...GEOMETRY, radius: 0.02 };
    const d = 60; // 0.02 units is 0.08 px here
    // A sheet of them, so the rasteriser's rounding of one tiny disc averages out.
    const list = [];
    for (let j = -6; j <= 6; j++) for (let i = -8; i <= 8; i++) list.push([i * 1.37 + 0.11 * j, j * 1.21 + 0.07 * i, -d, 11]);
    rig.clearScene();
    const frame = rig.pass.prepare(drawOf(rig.records(list), geometry), false);
    const enc = rig.device.createCommandEncoder();
    rig.pass.encodeSplat(enc, frame);
    rig.device.queue.submit([enc.finish()]);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    const depth = await rig.readDepth(rig.pass.textures.depth);
    const thickness = await rig.readThickness(rig.pass.textures.thickness);
    let covered = 0, volume = 0;
    for (let i = 0; i < W * H; i++) {
      if (depth[i] < 0.999) covered++;
      volume += thickness[i] * pixelArea(d);
    }
    const minPx = rig.app.fluidSurface.FLUID_MIN_SPLAT_PX;
    const expectCovered = list.length * Math.PI * minPx ** 2;
    assert.ok(covered > 0.6 * expectCovered && covered < 1.4 * expectCovered, `${covered} pixels for ${list.length} spheres (about ${expectCovered.toFixed(0)} expected)`);
    const liquid = list.length * geometry.thicknessScale * (4 / 3) * Math.PI * geometry.radius ** 3;
    assert.ok(Math.abs(volume / liquid - 1) < 0.25, `thickness sums to ${(volume / liquid).toFixed(3)} of the liquid's volume`);
    console.log(`  far: ${covered} px for ${list.length} sub-pixel spheres, volume ${(volume / liquid).toFixed(3)} of the liquid's`);
    rig.pass.destroy();
  });

  it('filter: both WGSL passes match the CPU twin, and smooth a lumpy blob', async () => {
    const rig = makeRig();
    assert.ok(await rig.pass.init());
    const fs = rig.app.fluidSurface;
    // A lumpy blob of overlapping spheres, and a second one well in front of part of it.
    const list = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 220; i++) list.push([(rnd() - 0.5) * 1.6, (rnd() - 0.5) * 1.1, -5 + (rnd() - 0.5) * 0.3, 11]);
    for (let i = 0; i < 40; i++) list.push([0.5 + (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 0.4, -3.2 + (rnd() - 0.5) * 0.1, 11]);
    rig.clearScene();
    const frame = rig.pass.prepare(drawOf(rig.records(list)), false);
    let enc = rig.device.createCommandEncoder();
    rig.pass.encodeSplat(enc, frame);
    rig.device.queue.submit([enc.finish()]);
    const raw = await rig.readDepth(rig.pass.textures.depth);
    enc = rig.device.createCommandEncoder();
    rig.pass.encodeFilter(enc, frame);
    rig.device.queue.submit([enc.finish()]);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    const gpuX = await rig.readDepth(rig.pass.textures.depthScratch);
    const gpuXY = await rig.readDepth(rig.pass.textures.depth);

    const p = { zFar: Z_FAR, filterRadius: GEOMETRY.filterRadius, filterRange: GEOMETRY.filterRange, filterMaxPx: fs.FLUID_FILTER_MAX_PX, projScaleY: PROJ[5] };
    const cpuX = fs.fluidFilterImage(raw, W, H, 0, p);
    const cpuXY = fs.fluidFilterImage(gpuX, W, H, 1, p);
    let worstX = 0, worstY = 0, liquid = 0;
    for (let i = 0; i < W * H; i++) {
      worstX = Math.max(worstX, Math.abs(gpuX[i] - cpuX[i]));
      worstY = Math.max(worstY, Math.abs(gpuXY[i] - cpuXY[i]));
      if (raw[i] < 0.999) liquid++;
      // The filter neither grows nor shrinks the liquid.
      assert.equal(gpuXY[i] < 0.999, raw[i] < 0.999, `pixel ${i} changed between liquid and none`);
    }
    assert.ok(liquid > 2000, `only ${liquid} liquid pixels`);
    // Depths are distance / 200: 2e-6 is 0.4 mm of scene at this scale.
    assert.ok(worstX < 2e-6 && worstY < 2e-6, `GPU vs CPU twin: ${worstX} along x, ${worstY} along y`);

    // Smoother: second differences fall in the interior of the far blob —
    // pixels whose whole filter window is that blob. (At a silhouette the
    // filter bends the surface back on purpose; that is not roughness.)
    const reach = fs.FLUID_FILTER_MAX_PX + 1;
    const farBlob = (i) => raw[i] * Z_FAR > 4.4 && raw[i] < 0.999;
    const interior = [];
    for (let y = reach; y < H - reach; y++) {
      for (let x = reach; x < W - reach; x++) {
        let inside = true;
        for (let dy = -reach; dy <= reach && inside; dy += reach) {
          for (let dx = -reach; dx <= reach && inside; dx++) inside = farBlob((y + dy) * W + x + dx) && farBlob((y + dx) * W + x + dy);
        }
        if (inside) interior.push(y * W + x);
      }
    }
    assert.ok(interior.length > 100, `only ${interior.length} interior pixels`);
    const rough = (d) => interior.reduce((s, i) => s + ((d[i + 1] - 2 * d[i] + d[i - 1]) * Z_FAR) ** 2 + ((d[i + W] - 2 * d[i] + d[i - W]) * Z_FAR) ** 2, 0) / interior.length;
    assert.ok(rough(gpuXY) < 0.1 * rough(raw), `roughness ${rough(gpuXY)} after, ${rough(raw)} before`);
    // The near blob is not smeared into the far one: where it was, it still is, within δ.
    let checked = 0;
    for (let i = 0; i < W * H; i++) {
      if (raw[i] * Z_FAR < 3.6) {
        checked++;
        assert.ok(gpuXY[i] * Z_FAR < 3.6 + GEOMETRY.filterRange, `near blob pixel ${i} moved from ${raw[i] * Z_FAR} to ${gpuXY[i] * Z_FAR}`);
      }
    }
    assert.ok(checked > 200);
    console.log(`  filter: ${liquid} liquid px, GPU − CPU ≤ ${Math.max(worstX, worstY).toExponential(1)}, roughness × ${(rough(gpuXY) / rough(raw)).toFixed(3)}`);
    rig.pass.destroy();
  });

  /** One full frame of the pass over a cleared scene; returns the scene colour before and after, and the liquid mask. */
  async function composite(rig, list, geometry = GEOMETRY, metresPerUnit = 0.64) {
    rig.clearScene();
    const before = await rig.readColor();
    const enc = rig.device.createCommandEncoder();
    assert.ok(rig.pass.encode(enc, drawOf(rig.records(list), geometry, metresPerUnit), false), 'the pass bailed');
    rig.device.queue.submit([enc.finish()]);
    const color = await rig.readColor();
    const depth = await rig.readDepth(rig.pass.textures.depth);
    return { before, color, depth };
  }

  it('composite: only liquid pixels change; a wall in front of the liquid hides it', async () => {
    const list = [];
    for (let i = 0; i < 60; i++) list.push([Math.cos(i * 2.4) * 0.03 * i ** 0.5 * 2, Math.sin(i * 2.4) * 0.03 * i ** 0.5 * 2, -4, 11]);

    const open = makeRig();
    assert.ok(await open.pass.init());
    const a = await composite(open, list);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    // The cleared scene is the backdrop, as the target's format stores it.
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(a.before[c] - [open.BACKDROP.r, open.BACKDROP.g, open.BACKDROP.b][c]) < 0.02);
    let changed = 0, untouched = 0, liquid = 0;
    for (let i = 0; i < W * H; i++) {
      const px = [a.color[i * 3], a.color[i * 3 + 1], a.color[i * 3 + 2]];
      // Decoded from the same bits, an untouched pixel is the same number.
      const same = px.every((v, c) => v === a.before[i * 3 + c]);
      assert.ok(px.every(Number.isFinite), `pixel ${i} is not finite`);
      if (a.depth[i] < 0.999) {
        liquid++;
        if (!same) changed++;
      } else {
        assert.ok(same, `pixel ${i} has no liquid but changed to ${px}`);
        untouched++;
      }
    }
    assert.ok(liquid > 500 && changed > 0.9 * liquid, `${changed} of ${liquid} liquid pixels changed`);
    assert.ok(untouched > 0.8 * W * H);

    // The same liquid behind an opaque wall 2 units away: nothing changes at all.
    const walled = makeRig({ sceneDistance: 2 });
    assert.ok(await walled.pass.init());
    const b = await composite(walled, list);
    for (let i = 0; i < W * H * 3; i++) assert.ok(b.color[i] === b.before[i], `pixel ${Math.floor(i / 3)} changed behind the wall`);
    // …and in front of a wall 8 units away it is drawn as before.
    const behind = makeRig({ sceneDistance: 8 });
    assert.ok(await behind.pass.init());
    const c = await composite(behind, list);
    let drawn = 0;
    for (let i = 0; i < W * H; i++) if (c.color[i * 3] !== c.before[i * 3] || c.color[i * 3 + 2] !== c.before[i * 3 + 2]) drawn++;
    assert.ok(drawn > 0.9 * changed, `${drawn} pixels drawn in front of a far wall, ${changed} with no wall`);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    console.log(`  composite: ${changed} of ${liquid} liquid px shaded, ${untouched} others untouched; hidden behind a wall, drawn in front of one`);
    for (const r of [open, walled, behind]) r.pass.destroy();
  });

  it('composite: thicker liquid absorbs more, red before blue; each look has its own colour', async () => {
    // A slab of spheres one layer deep, and the same slab six layers deep, at a
    // scale where a layer is 6 mm of liquid (0.58 units of summed chord a layer).
    const METRES_PER_UNIT = 0.01;
    const slab = (layers) => {
      const list = [];
      for (let k = 0; k < layers; k++) for (let j = -5; j <= 5; j++) for (let i = -5; i <= 5; i++) list.push([i * 0.12, j * 0.12, -4 - k * 0.12, 11]);
      return list;
    };
    const centreColor = async (look, layers) => {
      const rig = makeRig({ look });
      assert.ok(await rig.pass.init());
      const { color } = await composite(rig, slab(layers), GEOMETRY, METRES_PER_UNIT);
      // Mean over a patch in the middle of the slab.
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = H / 2 - 6; y < H / 2 + 6; y++) for (let x = W / 2 - 6; x < W / 2 + 6; x++, n++) for (let c = 0; c < 3; c++) sum[c] += color[(y * W + x) * 3 + c];
      rig.pass.destroy();
      return sum.map((v) => v / n);
    };
    const thin = await centreColor('studio', 1);
    const thick = await centreColor('studio', 6);
    assert.deepEqual(session.device.uncaptured, [], 'GPU validation errors');
    // Thicker: darker in red, and red has fallen by more than blue.
    assert.ok(thick[0] < thin[0], `red ${thin[0]} thin, ${thick[0]} thick`);
    assert.ok(thick[0] / thin[0] < thick[2] / thin[2], `red fell to ${(thick[0] / thin[0]).toFixed(3)}, blue to ${(thick[2] / thin[2]).toFixed(3)}`);
    // The dyed looks differ: drama's liquid is deeper than lab's.
    const lab = await centreColor('lab', 6);
    const drama = await centreColor('drama', 6);
    assert.ok(drama[0] < lab[0], `red through six layers: lab ${lab[0]}, drama ${drama[0]}`);
    console.log(`  absorption: thin ${thin.map((v) => v.toFixed(3))}, thick ${thick.map((v) => v.toFixed(3))}; lab ${lab[0].toFixed(3)} / drama ${drama[0].toFixed(3)} red`);
  });
});
