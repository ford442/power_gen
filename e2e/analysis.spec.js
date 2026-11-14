// @ts-check
import { test, expect } from '@playwright/test';
import { gotoWebGL2, trackPageErrors, waitForEval } from './helpers.js';

/**
 * Analysis panel (#224 §4): two synthetic runs go in through the run store,
 * `window.openAnalysis` lazy-loads uPlot + the panel, and the plot-hint
 * linear fit prints its R². WebGL2 only — the panel never touches the GPU API.
 */
test.describe('Analysis panel (WebGL2)', () => {
  test('two runs → uPlot canvas, linear-fit R², spectrum, Esc closes, 390 px', async ({ page }) => {
    // SwiftShader WebGL2 frames can hold the main thread for seconds, and the
    // dev server serves the lazy chunk as a dozen modules (uPlot included).
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 960, height: 540 });
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => typeof window.openAnalysis === 'function' && !!window.analysisRuns
      && !!document.getElementById('analysisOpenBtn'), { timeout: 60_000 });
    // This test is about the panel, not the scene: cap the render loop at
    // ~2 fps so module loading and uPlot get the main thread.
    await page.evaluate(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => window.setTimeout(() => raf(cb), 500);
    });

    const ids = await page.evaluate(() => {
      /** F = k·B + 0.1 at 50 Hz, with the hint the panel should default to. */
      const mk = (id, title, k) => ({
        id,
        experimentId: 'e2e-lorentz-linearity',
        title,
        startedAt: new Date().toISOString(),
        runner: 'offline',
        backend: 'js',
        hz: 50,
        columns: ['t', 'lorentzFieldT', 'lorentzForceN'],
        rows: Array.from({ length: 64 }, (_, i) => [i / 50, i / 64, k * (i / 64) + 0.1 + 0.05 * Math.sin(3 * i)]),
        plots: [{ x: 'lorentzFieldT', y: 'lorentzForceN', fit: 'linear' }],
        expects: [{ label: 'fit lorentzForceN ~ lorentzFieldT (linear)', pass: true, measured: { r2: 0.999 }, condition: 'r2 > 0.98' }]
      });
      window.analysisRuns.addRun(mk('e2e-ref', 'reference', 2.5));
      window.analysisRuns.addRun(mk('e2e-mine', 'mine', 2.4));
      return ['e2e-mine', 'e2e-ref'];
    });
    // Fire and poll: one evaluate awaiting the chunk would starve like a frame.
    await page.evaluate((runIds) => { void window.openAnalysis(runIds); }, ids);
    await waitForEval(page, () => !!document.querySelector('#analysis-panel:not([hidden]) .uplot canvas'), { timeout: 240_000 });

    const xy = await page.evaluate(() => {
      const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('#analysis-panel .uplot canvas'));
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted++;
      return {
        w: canvas.width,
        h: canvas.height,
        painted,
        fit: document.querySelector('#analysis-panel .analysis-fit')?.textContent ?? '',
        disclaimer: document.querySelector('#analysis-panel .analysis-disclaimer')?.textContent ?? '',
        expects: document.querySelector('#analysis-panel .analysis-expects')?.textContent ?? '',
        legend: document.querySelectorAll('#analysis-panel .u-legend .u-series').length,
        pressed: document.querySelector('#analysis-panel [aria-pressed="true"]')?.textContent ?? ''
      };
    });
    expect(xy.w).toBeGreaterThan(100);
    expect(xy.h).toBeGreaterThan(100);
    expect(xy.painted, 'uPlot drew axes / points').toBeGreaterThan(500);
    expect(xy.pressed).toBe('X–Y');
    expect(xy.fit).toMatch(/R² = 0\.99\d{3}/);
    expect(xy.fit).toContain('F = 2.4');
    expect(xy.disclaimer).toBe('Simulated — not metrology');
    expect(xy.expects).toContain('PASS');
    // mine + overlay + fit (a non-live uPlot legend leaves out the x series)
    expect(xy.legend).toBe(3);

    // Spectrum view: FFT of F at the run's 50 Hz → peak readout.
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('#analysis-panel button')].find((b) => b.textContent === 'Spectrum');
      /** @type {HTMLButtonElement} */ (btn).click();
    });
    await waitForEval(page, () => (document.querySelector('#analysis-panel .analysis-notes')?.textContent ?? '').includes('Peak'),
      { timeout: 30_000 });
    const notes = await page.evaluate(() => document.querySelector('#analysis-panel .analysis-notes')?.textContent ?? '');
    expect(notes).toMatch(/N = 64 · Hann/);

    // Esc closes the dialog.
    await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#analysis-panel .analysis-close')).focus());
    await page.keyboard.press('Escape');
    await waitForEval(page, () => document.getElementById('analysis-panel')?.hidden === true, { timeout: 15_000 });

    // Phone width: the dashboard button reopens it and nothing overflows 390 px.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => /** @type {HTMLButtonElement} */ (document.getElementById('analysisOpenBtn')).click());
    await waitForEval(page, () => !!document.querySelector('#analysis-panel:not([hidden]) .uplot canvas'), { timeout: 30_000 });
    const phone = await page.evaluate(() => {
      const dialog = document.querySelector('#analysis-panel .analysis-dialog').getBoundingClientRect();
      const plot = document.querySelector('#analysis-panel .uplot').getBoundingClientRect();
      const panel = document.getElementById('analysis-panel');
      return { dialogRight: dialog.right, plotRight: plot.right, scrollW: panel.scrollWidth, clientW: panel.clientWidth };
    });
    expect(phone.dialogRight).toBeLessThanOrEqual(390);
    expect(phone.plotRight).toBeLessThanOrEqual(390);
    expect(phone.scrollW).toBeLessThanOrEqual(phone.clientW);

    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });
});
