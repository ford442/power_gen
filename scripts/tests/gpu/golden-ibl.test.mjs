/**
 * test:gpu-golden — ibl-prefilter-compute.wgsl (#258 §3).
 *
 * The GPU bake runs through the app's own `IblPrefilterCompute` (pipeline,
 * per-layer uniform slices, one dispatch per layer) into the app's own IBL
 * array texture, for each lighting look, and every layer is read back.
 *
 * Two checks per look:
 *
 *   energy   The prefilter is a normalised blur of the analytic studio
 *            environment, so each layer's mean radiance over the sphere
 *            (texels weighted by their octahedral solid angle) must match the
 *            source's — layer 0, the unfiltered environment. A kernel that
 *            leaks, double-counts or mis-normalises its weights moves the
 *            mean by tens of percent; so does a layer written to the wrong
 *            slice. The bound is 4 %, not the 2 % #258 proposed: a GGX lobe
 *            is only mean-preserving in the continuum, and at the 24–32
 *            Hammersley taps the rough layers use the quadrature itself is
 *            off by up to 3.2 % (lab look, roughness 1) — in the CPU bake
 *            too, to the same digits. Studio stays under 2 %.
 *   twin     Texel for texel against the CPU bake (`prefilterEnvironment`
 *            in src/ibl-prefilter.ts), which is the runtime fallback — the
 *            two must be interchangeable or the look changes with the code
 *            path. Same sample counts and Hammersley sequence, f32 vs f64:
 *            within 1 % of the layer's peak, on a software rasteriser.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gpuSkip, nodeGpu, readTexture } from '../../lib/node-gpu.mjs';
import { gpuSession, halfToFloat } from '../../lib/gpu-app.mjs';

const gpu = await nodeGpu();
const skip = gpuSkip(gpu);
const session = skip ? null : await gpuSession(gpu, { label: 'golden-ibl' });

const ENERGY_TOL = 0.04;
const TWIN_TOL = 0.01;

/**
 * Solid angle of each texel of an n×n octahedral map, normalised to sum 1.
 * The map is the L1 unit octahedron projected onto the sphere, for which
 * dω = dA / |v|³ with v the un-normalised decoded vector (same on the folded
 * lower half: the fold is a reflection).
 */
function octSolidAngles(n) {
  const w = new Float64Array(n * n);
  let sum = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = ((x + 0.5) / n) * 2 - 1;
      const pz = ((y + 0.5) / n) * 2 - 1;
      const py = 1 - Math.abs(px) - Math.abs(pz);
      const vx = py < 0 ? (1 - Math.abs(pz)) * Math.sign(px) : px;
      const vz = py < 0 ? (1 - Math.abs(px)) * Math.sign(pz) : pz;
      const len = Math.hypot(vx, py, vz);
      w[y * n + x] = 1 / len ** 3;
      sum += w[y * n + x];
    }
  }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  return w;
}

/** Solid-angle-weighted mean RGB of one rgba layer. */
function meanRadiance(rgba, weights) {
  const m = [0, 0, 0];
  for (let i = 0; i < weights.length; i++) {
    for (let c = 0; c < 3; c++) m[c] += rgba[i * 4 + c] * weights[i];
  }
  return m;
}

describe('gpu-golden: ibl-prefilter-compute.wgsl — energy per layer, and the CPU bake', { skip }, () => {
  const looks = skip ? [] : Object.keys(session.app.LIGHTING_LOOKS);
  let resources;
  let compute;
  const setup = async () => {
    if (compute) return;
    const { app, device, cache, shaders } = session;
    // The app never reads the environment back, so the texture has no COPY_SRC.
    const create = device.createTexture;
    device.createTexture = (d) => create.call(device, { ...d, usage: d.usage | GPUTextureUsage.COPY_SRC });
    try {
      resources = await app.ibl.createIblResources(device);
    } finally {
      device.createTexture = create;
    }
    assert.ok(resources.storage, 'rgba16float storage binding rejected — the compute bake cannot run here');
    compute = await app.IblPrefilterCompute.create(device, cache, resources, shaders.iblPrefilterComputeShader);
    assert.ok(compute, 'IblPrefilterCompute.create fell back to the CPU bake');
  };

  for (const look of looks) {
    it(`${look}: each layer keeps the environment's energy within ${ENERGY_TOL * 100} %; matches the CPU bake within ${TWIN_TOL * 100} % of peak`, async () => {
      await setup();
      const { app, device } = session;
      const preset = app.getLightingPreset(look, 'linear');
      const { layers } = compute.bake(preset, resources.size);
      assert.equal(layers, app.ibl.IBL_LAYERS);
      const gpuLayers = [];
      for (let layer = 0; layer < layers; layer++) {
        const { data } = await readTexture(device, resources.texture, { layer, bytesPerPixel: 8 });
        gpuLayers.push(halfToFloat(data));
      }
      assert.deepEqual(device.uncaptured, [], 'GPU validation errors');

      const n = resources.size;
      const weights = octSolidAngles(n);
      const source = meanRadiance(gpuLayers[0], weights);
      const sourceLuma = (source[0] + source[1] + source[2]) / 3;
      assert.ok(sourceLuma > 1e-3, `layer 0 is black (mean ${source}) — the bake wrote nothing`);

      const cpu = app.ibl.prefilterEnvironment(preset);
      const cpuFloat = halfToFloat(new Uint8Array(cpu.data.buffer, cpu.data.byteOffset, cpu.data.byteLength));
      const energy = [];
      const twin = [];
      for (let layer = 0; layer < layers; layer++) {
        const g = gpuLayers[layer];
        assert.ok(g.every(Number.isFinite), `layer ${layer}: non-finite texel`);
        const mean = meanRadiance(g, weights);
        const drift = Math.max(...mean.map((v, c) => Math.abs(v - source[c]))) / sourceLuma;
        energy.push(`${(drift * 100).toFixed(2)}%`);
        assert.ok(drift <= ENERGY_TOL,
          `layer ${layer}: mean radiance [${mean.map((v) => v.toFixed(4))}] vs the environment's [${source.map((v) => v.toFixed(4))}] — ${(drift * 100).toFixed(2)} % off`);

        const c = cpuFloat.subarray(layer * n * n * 4, (layer + 1) * n * n * 4);
        let peak = 0;
        let worst = 0;
        let at = 0;
        for (let i = 0; i < c.length; i++) {
          if (i % 4 === 3) { assert.equal(g[i], 1, `layer ${layer}: alpha`); continue; }
          peak = Math.max(peak, Math.abs(c[i]));
          const d = Math.abs(g[i] - c[i]);
          if (d > worst) { worst = d; at = i; }
        }
        twin.push((worst / peak).toExponential(1));
        assert.ok(worst <= TWIN_TOL * peak,
          `layer ${layer}: GPU and CPU bakes differ by ${worst} (${(100 * worst / peak).toFixed(2)} % of peak ${peak}) at texel `
          + `(${(at >> 2) % n}, ${Math.floor((at >> 2) / n)}) channel ${at % 4}`);
      }
      console.log(`  energy drift per layer: ${energy.join(' ')}\n  GPU − CPU / peak:       ${twin.join(' ')}`);
    });
  }
});
