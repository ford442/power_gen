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
  heron: ['rollerPipeline', 'particlePipeline', 'fieldLinePipeline'],
  kelvin: ['rollerPipeline', 'particlePipeline', 'fieldLinePipeline'],
  solar: ['rollerPipeline', 'particlePipeline', 'fieldLinePipeline']
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
    expect(info?.pipelineTiers?.states.msaa, 'MSAA pipelines never compiled').toBe('idle');
    expect(info?.pipelineTiers?.states.shadow, 'shadow casters never compiled').toBe('idle');
    await expectNoGpuErrors(page, 'showroom overview');
    expect(errors, 'console errors / uncaught exceptions').toEqual([]);
  });
});
