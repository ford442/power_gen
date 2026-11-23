// @ts-check
/**
 * WebGPU runtime e2e (#258 §4) — the primary renderer, in a real browser, on
 * SwiftShader. Small on purpose: what only a browser can tell us.
 *
 *   1. boot       default boot is WebGPU, with zero GPU errors and a clean console
 *   2. benches    every bench draws, without a validation error; the pipelines
 *                 a bench must draw with are the ones that drew (#252)
 *   3. tiers      `high` tier runs the shadow / MSAA / TAA / field-volume / FDTD
 *                 passes on their own pipeline variants, still error-free
 *   4. loss       a lost device recovers with zero validation errors (#221)
 *   5. showroom   the post chain encodes; overview allocates no shadow / MSAA
 *                 targets (the frame graph's lazy targets, on a real device)
 */
import { test, expect } from '@playwright/test';
import {
  bootWebgpu, drawnPipelines, focusView, gpuErrors, installDrawProbe, missingDraws, pinQualityTier,
  renderFrames, rendererInfo, trackErrors, waitForEval
} from './webgpu-helpers.js';

/** Clean GPU state: nothing uncaptured, no device lost. */
async function expectNoGpuErrors(page, where) {
  const e = await gpuErrors(page);
  expect(e, '__gpuErrors is installed').not.toBeNull();
  expect(e?.messages.filter((m) => m.startsWith('uncaptured')) ?? [], `GPU errors ${where}`).toEqual([]);
  expect(e?.uncaptured, `uncaptured GPU errors ${where}`).toBe(0);
}

/**
 * Pipelines a bench must draw with in focus at SwiftShader's boot tier
 * (`low`, quality 0.5), by pipeline label. Minimum sets — a bench may draw
 * more. `compute:` entries are compute dispatches.
 */
const MUST_DRAW = {
  // Rollers / stator / CAD on the PBR pipeline, pickup coils, RK4 flux
  // ribbons (always null before #252), particles.
  seg: ['segEnhancedPipeline', 'coilPipeline', 'fluxSegmentPipeline', 'particlePipeline', 'compute:seg-roller-compute-pipeline', 'compute:flux-tracer-pipeline'],
  // Flux ribbons around the core: never drew on WebGPU before #252.
  transformer: ['rollerPipeline', 'particlePipeline', 'fluxSegmentPipeline', 'compute:transformer-flux-compute-pipeline'],
  // The liquid solver (ADR-0022): on at the low tier this file pins, so its
  // emit, substep and export passes all have to dispatch.
  heron: ['rollerPipeline', 'particlePipeline', 'fieldLinePipeline',
    'compute:mpm-emit-pipeline', 'compute:mpm-p2g-pipeline', 'compute:mpm-grid-pipeline', 'compute:mpm-g2p-pipeline', 'compute:mpm-export-pipeline'],
  // The same solver steps Kelvin's drops (a small grid, a few dozen particles).
  kelvin: ['rollerPipeline', 'particlePipeline', 'fieldLinePipeline',
    'compute:mpm-emit-pipeline', 'compute:mpm-p2g-pipeline', 'compute:mpm-grid-pipeline', 'compute:mpm-g2p-pipeline', 'compute:mpm-export-pipeline'],
  solar: ['rollerPipeline', 'particlePipeline', 'fieldLinePipeline'],
  // The duct's lattice-Boltzmann slice: its step, the potential's sweeps, the
  // reductions, the stream function, and the panel in the scene pass.
  mhd: ['particlePipeline', 'mhd-slice-draw-pipeline',
    'compute:mhd-slice-step-pipeline', 'compute:mhd-slice-sor-red-pipeline', 'compute:mhd-slice-sor-black-pipeline',
    'compute:mhd-slice-reduce-columns-pipeline', 'compute:mhd-slice-reduce-electrodes-pipeline', 'compute:mhd-slice-stream-function-pipeline']
};
/** Every bench: its mesh, its particles, the particle compute, the post chain. */
const EVERY_BENCH = ['particlePipeline', 'compute:compute-particle-pipeline', 'bloomPrefilter', 'bloomDownsample', 'bloomUpsample', 'bloomComposite'];

test.describe('WebGPU on SwiftShader', () => {
  test('1. default boot is WebGPU with zero GPU errors and a clean console', async ({ page }) => {
    const errors = trackErrors(page);
    await bootWebgpu(page);
    await renderFrames(page, 5);

    const info = await rendererInfo(page);
    expect(info?.renderer).toBe('webgpu');
    expect(await page.evaluate(() => window.currentRenderer)).toBe('webgpu');
    expect(info?.frameGraph?.ran, 'passes of a default overview frame').toEqual(expect.arrayContaining(['scene', 'composite']));
    // Overview, every bench enabled: the liquid solver is neither built nor allocated.
    expect(info?.fluid?.allocated, 'liquid solver buffers in overview').toBe(false);
    expect(info?.fluid?.build).toBe('pending');
    expect(info?.frameGraph?.allocated ?? []).not.toEqual(expect.arrayContaining(['heron-liquid']));
    expect(await page.evaluate(() => document.getElementById('webgpu-device-lost'))).toBeNull();
    await expectNoGpuErrors(page, 'after boot');
    expect(errors, 'console errors / uncaught exceptions').toEqual([]);
  });

  test('2. every bench draws without a validation error, with its own pipelines', async ({ page }) => {
    const errors = trackErrors(page);
    await installDrawProbe(page);
    await bootWebgpu(page);
    // Auto-quality would otherwise drift with the runner's frame time, and
    // which pipeline draws a bench's field lines depends on the tier.
    await pinQualityTier(page, 'low');
    const ids = await page.evaluate(() => Object.keys(/** @type {any} */ (window.multiVisualizer).devices));
    expect(ids.length, 'registered benches').toBeGreaterThanOrEqual(16);

    /** @type {string[]} */
    const problems = [];
    for (const id of ids) {
      await focusView(page, id);
      await renderFrames(page, 3);
      // Normally all there after three frames; a lazily built pass gets up to a minute.
      for (const want of await missingDraws(page, [...EVERY_BENCH, ...(MUST_DRAW[id] ?? [])], 60_000)) {
        problems.push(`${id}: ${want} did not draw`);
      }
      const drew = await drawnPipelines(page);
      const mesh = drew.some((p) => p === 'rollerPipeline' || p === 'segEnhancedPipeline');
      if (!mesh) problems.push(`${id}: no mesh pipeline drew (${drew.join(', ')})`);
      const e = await gpuErrors(page);
      if (e?.uncaptured) problems.push(`${id}: ${e.uncaptured} GPU error(s) — ${e.messages.at(-1)}`);
    }
    expect(problems, 'per-bench problems').toEqual([]);
    await expectNoGpuErrors(page, 'after focusing every bench');
    expect(errors, 'console errors / uncaught exceptions').toEqual([]);
  });

  test('3. high tier: shadow, MSAA, TAA, field volume and FDTD run on their own pipelines', async ({ page }) => {
    const errors = trackErrors(page);
    await installDrawProbe(page);
    await bootWebgpu(page);
    await pinQualityTier(page, 'high');

    // SEG: showroom MSAA + key-light shadow + TAA; the field volume traces its lines.
    await focusView(page, 'seg');
    await waitForEval(page, () => {
      const i = window.getRendererInfo?.();
      return ['msaa', 'taa', 'shadow'].every((t) => i?.pipelineTiers?.states[t] === 'ready');
    }, { timeout: 300_000 });
    await renderFrames(page, 3);
    let info = await rendererInfo(page);
    expect(info?.frameGraph?.ran).toEqual(expect.arrayContaining(['shadow', 'scene', 'depth-resolve', 'taa', 'bloom', 'composite', 'history']));
    expect(info?.frameGraph?.allocated).toEqual(expect.arrayContaining(['msaa', 'taa', 'history', 'shadow']));
    expect(await missingDraws(page, ['segEnhancedPipeline_msaa4', 'segEnhancedShadowPipeline', 'coilPipeline_msaa4',
      'particlePipeline_msaa4', 'depthResolvePipeline', 'taa-resolve-pipeline']), 'SEG at high tier: pipelines that never drew').toEqual([]);
    const drew = await drawnPipelines(page);
    expect(drew.filter((p) => /^(roller|segEnhanced|particle|coil)Pipeline$/.test(p)), '1× scene pipelines in an MSAA pass').toEqual([]);
    await expectNoGpuErrors(page, 'SEG focus at high tier');

    // Pulse coil: the FDTD wave slice steps and draws; the volume owns the field lines.
    await focusView(page, 'pulse-coil');
    await renderFrames(page, 3);
    // Both passes are built on the first frame their gate opens (async
    // pipeline compiles), so they start drawing a few frames in. (The volume
    // itself is only re-solved when its sources change; its lines draw every frame.)
    expect(await missingDraws(page, ['compute:fdtd-updateH-pipeline', 'compute:fdtd-updateE-pipeline', 'fdtdSlicePipeline_msaa4',
      'fieldLinesPipeline_msaa4', 'rollerPipeline_msaa4', 'rollerShadowPipeline'], 300_000), 'pulse-coil at high tier: pipelines that never drew').toEqual([]);
    expect((await rendererInfo(page))?.frameGraph?.ran, 'frame-graph passes at pulse-coil focus').toEqual(expect.arrayContaining(['shadow', 'depth-resolve', 'taa']));
    await expectNoGpuErrors(page, 'pulse-coil focus at high tier');

    // Back in overview nothing tier-gated runs, and the lazy targets are released later, not kept busy.
    await focusView(page, 'overview');
    await renderFrames(page, 3);
    info = await rendererInfo(page);
    expect(info?.frameGraph?.ran).not.toEqual(expect.arrayContaining(['shadow']));
    expect(info?.frameGraph?.ran).not.toEqual(expect.arrayContaining(['depth-resolve']));
    await expectNoGpuErrors(page, 'back in overview');
    expect(errors, 'console errors / uncaught exceptions').toEqual([]);
  });

  test('4. forced device loss recovers with zero validation errors', async ({ page }) => {
    await installDrawProbe(page);
    await bootWebgpu(page);
    await focusView(page, 'seg');
    await renderFrames(page, 3);
    const before = await rendererInfo(page);

    expect(await page.evaluate(() => window.simulateDeviceLost?.())).toBe(true);
    await waitForEval(page, () => (window.__gpuErrors?.lost ?? 0) >= 1, { timeout: 60_000 });
    // Recovery re-requests the adapter and rebuilds every GPU object; frames resume after.
    await page.evaluate((f) => { /** @type {any} */ (window).__framesAtLoss = f; }, before?.frames ?? 0);
    await waitForEval(page, () => (window.getRendererInfo?.()?.frames ?? 0) >= /** @type {any} */ (window).__framesAtLoss + 5, { timeout: 300_000 });
    await renderFrames(page, 3);

    const after = await rendererInfo(page);
    expect(after?.view, 'the view survives the loss').toBe('seg');
    expect(await page.evaluate(() => document.getElementById('webgpu-device-lost')), 'no reload overlay').toBeNull();
    const e = await gpuErrors(page);
    expect(e?.lost).toBe(1);
    expect(e?.messages.filter((m) => m.startsWith('uncaptured')) ?? [], 'validation errors during / after recovery').toEqual([]);
    expect(await drawnPipelines(page)).toEqual(expect.arrayContaining(['segEnhancedPipeline', 'bloomComposite']));
  });

  test('5. showroom drama look encodes the post chain; overview allocates no shadow / MSAA targets', async ({ page }) => {
    const errors = trackErrors(page);
    await installDrawProbe(page);
    await bootWebgpu(page, 'labMode=showroom&look=drama');
    await pinQualityTier(page, 'high');
    await focusView(page, 'overview');
    await renderFrames(page, 4);

    const info = await rendererInfo(page);
    expect(info?.frameGraph?.ran).toEqual(expect.arrayContaining(['scene', 'bloom', 'composite']));
    expect(await drawnPipelines(page)).toEqual(expect.arrayContaining(['bloomPrefilter', 'bloomDownsample', 'bloomUpsample', 'bloomComposite']));
    expect(await page.evaluate(() => /** @type {any} */ (window.multiVisualizer).lightingLook)).toBe('drama');
    // Even at `high`: overview never encodes the shadow pass or the MSAA path, so their targets stay unallocated.
    expect(info?.frameGraph?.allocated ?? [], 'lazy targets in overview').not.toEqual(expect.arrayContaining(['shadow']));
    expect(info?.frameGraph?.allocated ?? []).not.toEqual(expect.arrayContaining(['msaa']));
    expect(info?.shadow?.allocated, 'shadow map texture').toBe(false);
    // …and no fluid resources, with all benches on the floor (ADR-0022).
    expect(info?.frameGraph?.allocated ?? []).not.toEqual(expect.arrayContaining(['heron-liquid']));
    expect(info?.fluid?.allocated, 'liquid solver buffers in overview').toBe(false);
    expect(info?.fluid?.bytes).toBe(0);
    expect(info?.pipelineTiers?.states.msaa, 'MSAA pipelines never compiled').toBe('idle');
    expect(info?.pipelineTiers?.states.shadow, 'shadow casters never compiled').toBe('idle');
    await expectNoGpuErrors(page, 'showroom overview');
    expect(errors, 'console errors / uncaught exceptions').toEqual([]);
  });
  test('6. Heron liquid: runs in Heron focus with finite numbers, as a surface from the medium tier, and is released in overview', async ({ page }) => {
    const errors = trackErrors(page);
    await installDrawProbe(page);
    await bootWebgpu(page);
    await pinQualityTier(page, 'low');
    await focusView(page, 'heron');
    // Start the plant so there is a jet to simulate.
    await page.getByText('SPIN-UP', { exact: false }).first().click();
    await page.evaluate(() => {
      const d = /** @type {HTMLInputElement} */ (document.querySelector('#driveControl'));
      d.value = '90';
      d.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Lazily built, then a jet takes a few seconds to rise at one sixth speed.
    await waitForEval(page, () => {
      const f = window.getRendererInfo?.()?.fluid;
      return !!f && f.allocated && f.emitted > 200 && f.jetHeightM > 0.05;
    }, { timeout: 180_000 });

    const info = await rendererInfo(page);
    const fluid = info?.fluid;
    expect(fluid?.tier, 'the tier `auto` picks at low quality').toBe('low');
    expect(info?.frameGraph?.allocated ?? []).toEqual(expect.arrayContaining(['heron-liquid']));
    expect(info?.frameGraph?.ran ?? []).toEqual(expect.arrayContaining(['heron-liquid']));
    for (const key of ['live', 'emitted', 'drained', 'jetHeightM', 'cellM', 'bytes', 'substeps']) {
      expect(Number.isFinite(fluid?.[key]), `fluid.${key} = ${fluid?.[key]}`).toBe(true);
    }
    expect(fluid.live, 'particles in the box = emitted − drained').toBe(fluid.emitted - fluid.drained);
    expect(fluid.live).toBeGreaterThan(0);
    expect(fluid.live).toBeLessThanOrEqual(fluid.maxParticles);
    // The measured jet is on the hub next to the plant's v²/2g, and is of its order.
    const plant = await page.evaluate(() => {
      const p = /** @type {any} */ (window.multiVisualizer).devices.heron.physicsState;
      return { v: p.heronVExit, ideal: p.heronJetIdealM, jet: p.heronJetHeightM };
    });
    expect(plant.v).toBeGreaterThan(1);
    expect(plant.jet).toBeGreaterThan(0);
    expect(plant.jet).toBeLessThan(1.5 * plant.ideal + 0.05);
    await expectNoGpuErrors(page, 'Heron liquid running');

    // At the low tier the liquid is particles: no surface pass, none of its targets.
    expect(fluid.surface, 'surface pass at the low quality tier').toBe(false);
    expect(fluid.surfaceBytes).toBe(0);
    expect(info?.frameGraph?.ran ?? []).not.toEqual(expect.arrayContaining(['fluid-surface']));
    expect(info?.frameGraph?.allocated ?? []).not.toEqual(expect.arrayContaining(['fluid-surface']));

    // From `medium` up the bulk of it is splatted, filtered and shaded as a surface.
    await pinQualityTier(page, 'medium');
    await waitForEval(page, () => window.getRendererInfo?.()?.fluid?.surface === true, { timeout: 180_000 });
    await renderFrames(page, 3);
    const surfaced = await rendererInfo(page);
    expect(surfaced?.frameGraph?.ran ?? []).toEqual(expect.arrayContaining(['heron-liquid', 'fluid-surface']));
    expect(surfaced?.frameGraph?.allocated ?? []).toEqual(expect.arrayContaining(['heron-liquid', 'fluid-surface']));
    expect(surfaced?.fluid?.surfaceBytes).toBeGreaterThan(0);
    expect(surfaced?.fluid?.surfaceSize?.every((n) => n > 0)).toBe(true);
    const surfacePipelines = [
      'fluid-splat-depth-pipeline', 'fluid-splat-thickness-pipeline', 'fluid-filter-pipeline', 'fluid-composite-pipeline'
    ];
    expect(await missingDraws(page, surfacePipelines, 60_000), 'surface pipelines that never drew').toEqual([]);
    await expectNoGpuErrors(page, 'Heron liquid drawn as a surface');

    // Back to overview: nothing steps at once, and the buffers go after the frame graph's hysteresis.
    await focusView(page, 'overview');
    await renderFrames(page, 3);
    expect((await rendererInfo(page))?.fluid?.active, 'liquid stepping in overview').toBe(false);
    await waitForEval(page, () => window.getRendererInfo?.()?.fluid?.allocated === false, { timeout: 180_000 });
    const after = await rendererInfo(page);
    expect(after?.frameGraph?.allocated ?? []).not.toEqual(expect.arrayContaining(['heron-liquid']));
    expect(after?.frameGraph?.allocated ?? []).not.toEqual(expect.arrayContaining(['fluid-surface']));
    expect(after?.fluid?.bytes).toBe(0);
    expect(after?.fluid?.surfaceBytes, 'the surface targets outlive the liquid').toBe(0);
    const jetAfter = await page.evaluate(() => /** @type {any} */ (window.multiVisualizer).devices.heron.physicsState.heronJetHeightM);
    expect(jetAfter, 'the measured-jet channel reads "not measured" without a solver').toBe(0);
    await expectNoGpuErrors(page, 'after releasing the liquid');
    expect(errors, 'console errors / uncaught exceptions').toEqual([]);
  });
  test('7. Kelvin drops: run on the solver in Kelvin focus, count what lands, and are released in overview', async ({ page }) => {
    const errors = trackErrors(page);
    await bootWebgpu(page);
    await pinQualityTier(page, 'low');
    // Overview first: nothing of Kelvin's liquid exists.
    const idle = await rendererInfo(page);
    expect(idle?.kelvinLiquid?.allocated, 'Kelvin drops allocated in overview').toBe(false);
    expect(idle?.frameGraph?.allocated ?? []).not.toEqual(expect.arrayContaining(['kelvin-liquid']));

    await focusView(page, 'kelvin');
    // Open the tips.
    await page.getByText('SPIN-UP', { exact: false }).first().click();
    await page.evaluate(() => {
      const d = /** @type {HTMLInputElement} */ (document.querySelector('#driveControl'));
      d.value = '100';
      d.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Lazily built; then a drop takes a quarter of a second to fall.
    await waitForEval(page, () => {
      const k = window.getRendererInfo?.()?.kelvinLiquid;
      return !!k && k.allocated && k.emitted > 30 && k.landed + k.missed > 12;
    }, { timeout: 240_000 });

    const info = await rendererInfo(page);
    const k = info?.kelvinLiquid;
    expect(info?.frameGraph?.allocated ?? []).toEqual(expect.arrayContaining(['kelvin-liquid']));
    expect(info?.frameGraph?.ran ?? []).toEqual(expect.arrayContaining(['kelvin-liquid']));
    // The other liquid bench's resources are not this one's.
    expect(info?.frameGraph?.allocated ?? []).not.toEqual(expect.arrayContaining(['heron-liquid', 'fluid-surface']));
    for (const key of ['live', 'emitted', 'landed', 'missed', 'bytes', 'substeps']) {
      expect(Number.isFinite(k?.[key]), `kelvinLiquid.${key} = ${k?.[key]}`).toBe(true);
    }
    expect(k.live, 'drops in the box = let go − taken').toBe(k.emitted - k.landed - k.missed);
    expect(k.live).toBeGreaterThanOrEqual(0);
    expect(k.timeScale, 'the drops run on the plant\'s clock').toBe(1);
    // What landed is on the plant's state and on the hub, as a share.
    const plant = await page.evaluate(() => {
      const p = /** @type {any} */ (window.multiVisualizer).devices.kelvin.physicsState;
      return { measured: p.kelvinCollectionEff, charged: p.kelvinLandedShare, v: p.kelvinV };
    });
    expect(plant.charged).toBeGreaterThanOrEqual(0);
    expect(plant.charged).toBeLessThanOrEqual(1);
    if (plant.measured !== null) expect(plant.measured).toBeGreaterThan(0);
    expect(Number.isFinite(plant.v)).toBe(true);
    await expectNoGpuErrors(page, 'Kelvin drops running');

    // Back to overview: the plant is told nothing is measuring, and the solver goes.
    await focusView(page, 'overview');
    await renderFrames(page, 3);
    const out = await page.evaluate(() => /** @type {any} */ (window.multiVisualizer).devices.kelvin.physicsState.kelvinCollectionEff);
    expect(out, 'the landing share is "not measured" out of focus').toBeNull();
    expect((await rendererInfo(page))?.kelvinLiquid?.active, 'Kelvin drops stepping in overview').toBe(false);
    await waitForEval(page, () => window.getRendererInfo?.()?.kelvinLiquid?.allocated === false, { timeout: 180_000 });
    const after = await rendererInfo(page);
    expect(after?.frameGraph?.allocated ?? []).not.toEqual(expect.arrayContaining(['kelvin-liquid']));
    expect(after?.kelvinLiquid?.bytes).toBe(0);
    await expectNoGpuErrors(page, 'after releasing the drops');
    expect(errors, 'console errors / uncaught exceptions').toEqual([]);
  });

  test('8. MHD slice: runs in MHD focus, reads its electrodes, and is released in overview', async ({ page }) => {
    const errors = trackErrors(page);
    await bootWebgpu(page);
    await pinQualityTier(page, 'low');
    // Overview first: nothing of the slice exists.
    const idle = await rendererInfo(page);
    expect(idle?.mhdSlice?.allocated, 'MHD slice allocated in overview').toBe(false);
    expect(idle?.frameGraph?.allocated ?? []).not.toEqual(expect.arrayContaining(['mhd-slice']));

    await focusView(page, 'mhd');
    // Start the pump: the slice's inflow is the plant's speed.
    await page.getByText('SPIN-UP', { exact: false }).first().click();
    // Lazily built; then the electrodes are read back every dozen frames.
    await waitForEval(page, () => {
      const m = window.getRendererInfo?.()?.mhdSlice;
      return !!m && m.allocated && m.steps > 200 && Array.isArray(m.volts) && m.totalAmps > 0;
    }, { timeout: 240_000 });

    const info = await rendererInfo(page);
    const m = info?.mhdSlice;
    expect(info?.frameGraph?.allocated ?? []).toEqual(expect.arrayContaining(['mhd-slice']));
    expect(info?.frameGraph?.ran ?? []).toEqual(expect.arrayContaining(['mhd-slice']));
    // The liquid benches' resources are not this one's.
    expect(info?.frameGraph?.allocated ?? []).not.toEqual(expect.arrayContaining(['heron-liquid', 'kelvin-liquid', 'fluid-surface']));
    expect(m.grid).toEqual([256, 40]);
    expect(m.bytes).toBeGreaterThan(0);
    expect(m.bytes).toBeLessThan(2 * 1024 * 1024);
    expect(m.volts).toHaveLength(4);
    for (const v of [...m.volts, ...m.amps]) expect(Number.isFinite(v), `electrode readout ${v}`).toBe(true);
    // The plant is the authority: the slice delivers a current of its sign and no more than its ideal pair.
    const plant = await page.evaluate(() => {
      const p = /** @type {any} */ (window.multiVisualizer).devices.mhd.physicsState;
      return { amps: p.mhdCurrent, u: p.mhdFlowU };
    });
    expect(plant.u).toBeGreaterThan(0);
    expect(m.totalAmps).toBeLessThan(1.3 * plant.amps);
    expect(await page.locator('#mhd-slice-note').textContent()).toMatch(/lattice-Boltzmann/);
    await expectNoGpuErrors(page, 'MHD slice running');

    // Back to overview: the solver goes.
    await focusView(page, 'overview');
    await renderFrames(page, 3);
    expect((await rendererInfo(page))?.mhdSlice?.active, 'MHD slice stepping in overview').toBe(false);
    await waitForEval(page, () => window.getRendererInfo?.()?.mhdSlice?.allocated === false, { timeout: 180_000 });
    const after = await rendererInfo(page);
    expect(after?.frameGraph?.allocated ?? []).not.toEqual(expect.arrayContaining(['mhd-slice']));
    expect(after?.mhdSlice?.bytes).toBe(0);
    await expectNoGpuErrors(page, 'after releasing the slice');
    expect(errors, 'console errors / uncaught exceptions').toEqual([]);
  });
});
