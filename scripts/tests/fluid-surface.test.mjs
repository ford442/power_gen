/**
 * Screen-space liquid surface — what does not need a GPU (ADR-0022,
 * docs/FLUIDS.md → The surface).
 *
 *   - `packFluidSurfaceParams` against `FluidSurfaceParams` in the WGSL
 *   - splat geometry: summed chords are the liquid's own thickness
 *   - the narrow-range filter (CPU twin of fluid-filter.wgsl): flat stays
 *     flat, noise is smoothed, a step larger than δ is not blurred across,
 *     "no liquid" never drags an edge to the far plane
 *   - scene depth ↔ distance
 *   - optics per look; which quality tiers get a surface
 *   - the export's effect types and the CPU density twin
 *
 * The shaders themselves run in scripts/tests/gpu/golden-fluid-surface.test.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROOT, bundleTs } from '../test-harness.mjs';

const M = await bundleTs({
  contents: `
    export * from './src/fluids/fluid-surface.ts';
    export * as mpm from './src/fluids/mpm-params.ts';
    export { MpmCpu, mpmDensityRatio } from './src/fluids/mpm-cpu.ts';
    export { seedMpmBox, writeMpmParticle } from './src/fluids/mpm-seed.ts';
    export { liquidSurfaceWanted } from './src/visualizer/heron-liquid-pass.ts';
    export { heronLiquidScene } from './src/fluids/heron-liquid.ts';
    export { getHeronLayout } from './src/heron-layout.ts';
  `,
  sourcefile: 'fluid-surface-entry.ts'
});

const wgsl = (rel) => readFileSync(join(ROOT, 'src/shaders', rel), 'utf8');

/** Offsets of a WGSL struct of f32 / vec2f / vec3f / mat4x4f fields, by the WGSL layout rules. */
function wgslStruct(source, name) {
  const body = source.match(new RegExp(`struct ${name} \\{([^}]*)\\}`))?.[1];
  assert.ok(body, `struct ${name} not found`);
  let offset = 0;
  let align = 1;
  const fields = {};
  for (const m of body.matchAll(/^\s*(\w+)\s*:\s*(\w+)\s*,/gm)) {
    const [size, a] = { f32: [4, 4], u32: [4, 4], vec2f: [8, 8], vec3f: [12, 16], vec4f: [16, 16], mat4x4f: [64, 16] }[m[2]] ?? [];
    assert.ok(size, `${name}.${m[1]}: type ${m[2]} is not one this check knows`);
    offset = Math.ceil(offset / a) * a;
    fields[m[1]] = offset;
    offset += size;
    align = Math.max(align, a);
  }
  return { bytes: Math.ceil(offset / align) * align, fields };
}

/** A perspective projection as multi-device-camera.ts builds it (column-major, GL-style z). */
function perspective(fovDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf;
  return m;
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

describe('fluid-surface: the uniform block', () => {
  const struct = wgslStruct(wgsl('common/fluid-surface.wgsl'), 'FluidSurfaceParams');

  it('is the size and has the offsets the WGSL struct has', () => {
    assert.equal(struct.bytes, M.FLUID_SURFACE_PARAMS_BYTES);
    for (const [name, at] of Object.entries(M.FLUID_SURFACE_F)) {
      assert.equal(struct.fields[name], at * 4, `${name}: WGSL offset ${struct.fields[name]}, host float ${at}`);
    }
    // Every field the shader has is one the host knows (bar the padding).
    for (const name of Object.keys(struct.fields)) {
      if (!name.startsWith('pad')) assert.ok(name in M.FLUID_SURFACE_F, `${name} is in the WGSL struct only`);
    }
  });

  it('packs the camera axes, the projection terms and one filter direction per copy', () => {
    const proj = perspective(45, 16 / 9, 0.1, 200);
    // A view matrix whose rotation rows are right = +z, up = +y, back = −x.
    const view = new Float32Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, -5, 1]);
    const geometry = { radius: 0.01, thicknessScale: 0.24, filterRadius: 0.04, filterRange: 0.03, edgeThickness: 0.005 };
    const frame = {
      viewProj: IDENTITY, view, proj, origin: [1, 2, 3], targetSize: [1280, 720], zFar: 200, metresPerUnit: 0.64,
      geometry, optics: M.FLUID_LOOK_OPTICS.studio
    };
    const F = M.FLUID_SURFACE_F;
    const x = M.packFluidSurfaceParams(frame, 0);
    const y = M.packFluidSurfaceParams(frame, 1);
    assert.equal(x.length * 4, M.FLUID_SURFACE_PARAMS_BYTES);
    assert.deepEqual([...x.subarray(F.camRight, F.camRight + 3)], [0, 0, 1]);
    assert.deepEqual([...x.subarray(F.camUp, F.camUp + 3)], [0, 1, 0]);
    assert.deepEqual([...x.subarray(F.camBack, F.camBack + 3)], [-1, 0, 0]);
    assert.deepEqual([...x.subarray(F.origin, F.origin + 3)], [1, 2, 3]);
    assert.equal(x[F.projScale], proj[0]);
    assert.equal(x[F.projScale + 1], proj[5]);
    assert.equal(x[F.depthAB], proj[10]);
    assert.equal(x[F.depthAB + 1], proj[14]);
    assert.deepEqual([x[F.filterDir], x[F.filterDir + 1]], [1, 0]);
    assert.deepEqual([y[F.filterDir], y[F.filterDir + 1]], [0, 1]);
    assert.equal(x[F.minPixels], M.FLUID_MIN_SPLAT_PX);
    assert.ok(Math.abs(x[F.absorption] - 16) < 1e-6 && Math.abs(x[F.roughness] - 0.08) < 1e-6);
    // Apart from the direction the two copies are the same block.
    const rest = (a) => [...a].filter((_, i) => i !== F.filterDir && i !== F.filterDir + 1);
    assert.deepEqual(rest(x), rest(y));
  });

  it('constants the shaders repeat are the host\'s', () => {
    const filter = wgsl('passes/fluid-filter.wgsl');
    assert.equal(Number(filter.match(/const FLUID_FILTER_MAX_TAPS = (\d+);/)[1]), M.FLUID_FILTER_MAX_TAPS);
    const common = wgsl('common/fluid-surface.wgsl');
    assert.equal(Math.fround(Number(common.match(/const FLUID_EMPTY = ([\d.]+);/)[1])), M.FLUID_EMPTY);
    assert.ok(M.FLUID_FILTER_MAX_PX <= M.FLUID_FILTER_MAX_TAPS);
    // The effect types: export, splat and particle shaders agree.
    const exp = wgsl('passes/mpm-export.wgsl');
    assert.equal(Number(exp.match(/const MPM_EFFECT_LIQUID = ([\d.]+);/)[1]), M.mpm.MPM_EFFECT.liquid);
    assert.equal(Number(exp.match(/const MPM_EFFECT_SPRAY = ([\d.]+);/)[1]), M.mpm.MPM_EFFECT.spray);
    assert.equal(Number(exp.match(/const MPM_EFFECT_SURFACE = ([\d.]+);/)[1]), M.mpm.MPM_EFFECT.surface);
    assert.equal(Number(common.match(/const FLUID_EFFECT_SURFACE = ([\d.]+);/)[1]), M.mpm.MPM_EFFECT.surface);
    assert.equal(Number(common.match(/const FLUID_EFFECT_SPRAY = ([\d.]+);/)[1]), M.mpm.MPM_EFFECT.spray);
  });

  it('the io block carries the surface flag and the spray threshold where the WGSL reads them', () => {
    const cfg = M.mpm.mpmWaterConfig([16, 16, 16], 0.01, 1e-4, 512);
    const base = { emitters: [], counts: [], seconds: 0, baseId: 0, sinks: [], exportOrigin: [0, 0, 0], exportScale: 1 };
    const io = wgsl('common/mpm.wgsl').match(/struct MpmIoParams \{([^}]*)\}/)[1];
    // capacity, surface, sprayBelow, pad2 are the last four words of the block.
    assert.match(io, /capacity: u32,\s*surface: u32,[^\n]*\n\s*sprayBelow: f32,[^\n]*\n\s*pad2: u32,/);
    const words = M.mpm.MPM_IO_PARAMS_BYTES / 4;
    const on = M.mpm.packMpmIoParams(cfg, { ...base, surface: true, sprayBelow: 0.15 });
    assert.equal(new Uint32Array(on)[words - 4], 512);
    assert.equal(new Uint32Array(on)[words - 3], 1);
    assert.ok(Math.abs(new Float32Array(on)[words - 2] - 0.15) < 1e-7);
    const off = M.mpm.packMpmIoParams(cfg, base);
    assert.equal(new Uint32Array(off)[words - 3], 0);
    assert.equal(new Float32Array(off)[words - 2], 0);
  });
});

describe('fluid-surface: splat geometry', () => {
  it('the splat sphere is one particle spacing in radius, and thicknessScale takes its extra volume back out', () => {
    const cfg = M.mpm.mpmWaterConfig([32, 32, 32], 0.0125, 1e-4, 4096);
    const upm = 1 / 0.64;
    const g = M.fluidSurfaceGeometry(cfg, upm);
    const h = 0.0125 * upm;
    assert.ok(Math.abs(g.radius - 0.5 * h) < 1e-12);
    // Summed over the disc, a chord times the scale is the particle's volume.
    const sphere = (4 / 3) * Math.PI * g.radius ** 3;
    assert.ok(Math.abs(g.thicknessScale * sphere - h ** 3 / cfg.particlesPerCell) < 1e-15);
    assert.ok(g.thicknessScale > 0.2 && g.thicknessScale < 0.3, `scale ${g.thicknessScale}`);
    assert.ok(g.filterRadius > g.radius && g.filterRange > g.radius && g.edgeThickness < g.radius);
  });

  it('far away a splat is held at a minimum size on screen', () => {
    const projY = 1 / Math.tan((45 * Math.PI) / 360);
    const near = M.fluidSplatRadius(0.05, 2, 720, projY);
    assert.equal(near, 0.05);
    const far = M.fluidSplatRadius(0.01, 40, 720, projY);
    const pixels = (far * 0.5 * 720 * projY) / 40;
    assert.ok(Math.abs(pixels - M.FLUID_MIN_SPLAT_PX) < 1e-9, `${pixels} px`);
  });

  it('scene depth and distance are each other\'s inverse on the app\'s projection', () => {
    const proj = perspective(45, 16 / 9, 0.1, 200);
    for (const d of [0.2, 1, 7.5, 40, 150]) {
      // The projection itself: clip.z / clip.w for a point d in front of the camera.
      const ndcZ = (proj[10] * -d + proj[14]) / d;
      assert.ok(Math.abs(M.fluidSceneDepth(d, proj) - ndcZ) < 1e-6);
      assert.ok(Math.abs(M.fluidSceneDistance(ndcZ, proj) / d - 1) < 1e-5, `distance ${d}`);
    }
  });
});

describe('fluid-surface: the narrow-range filter', () => {
  const W = 48, H = 32;
  const p = { zFar: 200, filterRadius: 0.5, filterRange: 0.3, filterMaxPx: M.FLUID_FILTER_MAX_PX, projScaleY: 2.4142 };
  const image = (fn) => {
    const d = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = fn(x, y);
    return d;
  };
  const both = (d) => M.fluidFilterImage(M.fluidFilterImage(d, W, H, 0, p), W, H, 1, p);

  it('a flat sheet stays flat, and empty stays empty', () => {
    const z = 12 / p.zFar;
    const out = both(image(() => z));
    // Away from the border: there "no liquid" outside the target counts as δ behind.
    for (let y = 16; y < 17; y++) for (let x = 16; x < 32; x++) assert.ok(Math.abs(out[y * W + x] - z) < 2e-7);
    const empty = both(image(() => 1));
    assert.ok(empty.every((v) => v === 1));
  });

  it('smooths bumps smaller than δ', () => {
    const base = 12;
    const bumpy = image((x, y) => (base + 0.05 * Math.sin(x * 1.7) * Math.cos(y * 2.3)) / p.zFar);
    const out = both(bumpy);
    const rough = (d) => {
      let s = 0;
      for (let y = 10; y < 22; y++) for (let x = 12; x < 36; x++) s += (d[y * W + x + 1] - 2 * d[y * W + x] + d[y * W + x - 1]) ** 2;
      return s;
    };
    assert.ok(rough(out) < 0.05 * rough(bumpy), `second differences ${rough(out)} after, ${rough(bumpy)} before`);
  });

  it('does not blur across a step larger than δ: the near surface keeps its depth', () => {
    // A jet at 10 in front of a pool at 12 (δ = 0.3).
    const step = image((x) => (x < 24 ? 10 : 12) / p.zFar);
    const out = both(step);
    for (let x = 14; x < 24; x++) {
      const z = out[16 * W + x] * p.zFar;
      // The far side counts as at most δ behind, so the near side moves back by a fraction of δ at most.
      assert.ok(z >= 10 - 1e-4 && z < 10 + p.filterRange, `near side at x=${x} moved to ${z}`);
    }
    // Well inside the near side nothing has moved; right at the edge it has moved less than δ/2.
    assert.ok(Math.abs(out[16 * W + 8] * p.zFar - 10) < 1e-4);
    assert.ok(out[16 * W + 23] * p.zFar - 10 < 0.5 * p.filterRange);
    // The far side is not pulled towards the jet at all: nearer neighbours are left out.
    for (let x = 24; x < 36; x++) assert.ok(Math.abs(out[16 * W + x] * p.zFar - 12) < 1e-4, `far side at x=${x}`);
  });

  it('a silhouette is rounded back by at most δ, never dragged to the far plane', () => {
    const disc = image((x, y) => ((x - 24) ** 2 + (y - 16) ** 2 < 64 ? 12 / p.zFar : 1));
    const out = both(disc);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const inside = disc[y * W + x] < 1;
        if (!inside) assert.equal(out[y * W + x], 1, 'the filter must not grow the liquid');
        else assert.ok(out[y * W + x] * p.zFar >= 12 - 1e-4 && out[y * W + x] * p.zFar <= 12 + p.filterRange + 1e-4);
      }
    }
    // The centre is untouched, the rim is behind it.
    assert.ok(Math.abs(out[16 * W + 24] * p.zFar - 12) < 0.02);
    assert.ok(out[16 * W + 31] > out[16 * W + 24]);
  });

  it('the support is a size in the scene: it shrinks with distance and is capped in pixels', () => {
    // One bright pixel in a flat sheet: how far its influence reaches.
    const reach = (distance) => {
      const d = image((x, y) => (x === 24 && y === 16 ? distance - 0.2 : distance) / p.zFar);
      const out = M.fluidFilterImage(d, W, H, 0, p);
      let n = 0;
      for (let x = 0; x < W; x++) if (Math.abs(out[16 * W + x] * p.zFar - distance) > 1e-5) n++;
      return n;
    };
    const near = reach(3), far = reach(60);
    assert.ok(far < near, `reach ${near} px at 3 units, ${far} px at 60`);
    assert.ok(near <= 2 * M.FLUID_FILTER_MAX_PX + 1);
    assert.ok(far >= 1);
  });
});

describe('fluid-surface: optics and gate', () => {
  it('each look has its own liquid, all of them absorbing red most', () => {
    const looks = M.FLUID_LOOK_OPTICS;
    assert.deepEqual(Object.keys(looks).sort(), ['drama', 'lab', 'studio']);
    for (const [name, o] of Object.entries(looks)) {
      assert.ok(o.absorption[0] > o.absorption[1] && o.absorption[1] > o.absorption[2], `${name}: water is blue because it absorbs red`);
      assert.ok(o.roughness > 0.02 && o.roughness < 0.3 && o.refraction > 0);
      // A 3 cm jet is tinted, not opaque.
      const t = o.absorption.map((a) => Math.exp(-a * 0.03));
      assert.ok(t[0] > 0.4 && t[2] > 0.9, `${name}: 3 cm transmits ${t.map((v) => v.toFixed(2))}`);
    }
    assert.ok(looks.lab.absorption[0] < looks.studio.absorption[0] && looks.studio.absorption[0] < looks.drama.absorption[0]);
    assert.equal(M.fluidOpticsForLook('drama'), looks.drama);
    assert.equal(M.fluidOpticsForLook('lab'), looks.lab);
    for (const other of ['studio', undefined, null, 'nonsense']) assert.equal(M.fluidOpticsForLook(other), looks.studio);
  });

  it('a surface from the medium quality tier up; particles below', () => {
    assert.equal(M.liquidSurfaceWanted('critical'), false);
    assert.equal(M.liquidSurfaceWanted('low'), false);
    assert.equal(M.liquidSurfaceWanted('medium'), true);
    assert.equal(M.liquidSurfaceWanted('high'), true);
    assert.equal(M.liquidSurfaceWanted('ultra'), true);
  });
});

describe('fluid-surface: spray is liquid thinner than the threshold', () => {
  it('a lone particle reads a few percent of rest density, a block close to one', () => {
    const cfg = M.mpm.mpmWaterConfig([20, 20, 20], 0.01, 1e-4, 8192, { gravity: [0, 0, 0] });
    // A block 8 cells on a side at rest density, and one particle far from it.
    const sim = new M.MpmCpu(cfg);
    const block = M.seedMpmBox(cfg, { min: [0.04, 0.04, 0.04], max: [0.12, 0.12, 0.12] });
    const records = new Float32Array(block.length + M.mpm.MPM_PARTICLE_FLOATS);
    new Uint8Array(records.buffer).set(new Uint8Array(block.buffer, block.byteOffset, block.byteLength));
    M.writeMpmParticle(records, block.length / M.mpm.MPM_PARTICLE_FLOATS, [0.16, 0.16, 0.16]);
    sim.setParticles(records);
    sim.p2g();
    sim.gridUpdate();
    const inside = M.mpmDensityRatio(cfg, sim.gridVel, [0.08, 0.08, 0.08]);
    assert.ok(Math.abs(inside - 1) < 0.03, `block interior reads ${inside}`);
    const face = M.mpmDensityRatio(cfg, sim.gridVel, [0.04, 0.08, 0.08]);
    assert.ok(face > 0.4 && face < 0.6, `on the block's face it reads ${face}`);
    const lone = M.mpmDensityRatio(cfg, sim.gridVel, [0.16, 0.16, 0.16]);
    assert.ok(lone > 0.005 && lone < 0.08, `a lone particle reads ${lone}`);
    assert.ok(lone < M.FLUID_SPRAY_BELOW && face > M.FLUID_SPRAY_BELOW);
    assert.equal(M.mpmDensityRatio(cfg, sim.gridVel, [0.03, 0.17, 0.03]), 0);
  });

  it('Heron\'s jet at the default tier is liquid, not spray', () => {
    // A column the nozzle's width at rest density: what the emitter makes.
    const layout = M.getHeronLayout('classic');
    const scene = M.heronLiquidScene(layout, 'default');
    const cfg = { ...scene.config, gravity: [0, 0, 0] };
    const r = scene.nozzleRadiusM;
    const [cx, cy] = [scene.nozzle[0], scene.nozzle[1]];
    const sim = new M.MpmCpu(cfg);
    sim.setParticles(M.seedMpmBox(cfg, { min: [cx - r, cy, cx - r], max: [cx + r, cy + 0.1, cx + r] }));
    sim.p2g();
    sim.gridUpdate();
    const axis = M.mpmDensityRatio(cfg, sim.gridVel, [cx, cy + 0.05, cx]);
    assert.ok(axis > 3 * M.FLUID_SPRAY_BELOW, `jet axis reads ${axis}`);
  });
});
