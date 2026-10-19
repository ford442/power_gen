// @ts-check
import { test, expect } from '@playwright/test';
import { gotoWebGL2, trackPageErrors, waitForEval } from './helpers.js';

/**
 * Scripted experiments (#224 §3): a reference experiment runs offline in the
 * experiment worker (fresh bench, faster than real time), a short inline one
 * runs live on the session clock, and the panel lists the shipped ones.
 * WebGL2 only — experiments never touch the GPU API.
 */
test.describe('Experiments (WebGL2)', () => {
  test('offline worker run passes, live run follows the session clock, panel lists references', async ({ page }) => {
    // SwiftShader frames hold the main thread for seconds, and the dev server
    // serves the worker and the lazy chunks as many modules.
    test.setTimeout(720_000);
    await page.setViewportSize({ width: 960, height: 540 });
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => typeof window.lab?.runExperiment === 'function'
      && !!document.getElementById('experimentsOpenBtn'), { timeout: 90_000 });

    // Offline: the worker builds its own bench; the page only waits. Fire and
    // poll — one evaluate awaiting the run would starve like a frame.
    await page.evaluate(() => {
      window.__e2eOffline = null;
      window.lab.runExperiment('lorentz-force-vs-field', { runner: 'offline' })
        .then((run) => { window.__e2eOffline = { run }; })
        .catch((err) => { window.__e2eOffline = { error: String(err?.message ?? err) }; });
    });
    await waitForEval(page, () => window.__e2eOffline != null, { timeout: 240_000, intervalMs: 1000 });
    const offline = await page.evaluate(() => {
      const r = window.__e2eOffline;
      if (r.error) return { error: r.error };
      const run = r.run;
      return {
        runner: run.runner,
        backend: run.backend,
        experimentId: run.experimentId,
        columns: run.columns,
        rows: run.rows.length,
        expects: run.expects.map((e) => ({ label: e.label, pass: e.pass })),
        inStore: !!window.analysisRuns?.getRun(run.id)
      };
    });
    expect(offline.error, offline.error).toBeUndefined();
    expect(offline.runner).toBe('offline');
    expect(offline.experimentId).toBe('lorentz-force-vs-field');
    expect(['wasm', 'js']).toContain(offline.backend);
    expect(offline.columns).toEqual(['t', 'lorentzFieldT', 'lorentzCurrentA', 'lorentzForceN', 'lorentzSledVms']);
    // 10 s at 30 Hz, both ends included.
    expect(offline.rows).toBeGreaterThanOrEqual(300);
    expect(offline.expects.length).toBe(2);
    expect(offline.expects.every((e) => e.pass), JSON.stringify(offline.expects)).toBe(true);
    expect(offline.inStore, 'the run lands in the analysis run store').toBe(true);

    // Live: steps ride the session clock, cut at every 0.1 s record tick, so
    // the run takes as many frames as that needs (≈ 7). Short on purpose. With
    // the plant worker a sample lags one batch, so the field check reads the
    // last row, not the mean.
    await page.evaluate(() => {
      window.__e2eLive = null;
      const def = {
        id: 'e2e-live-lorentz',
        title: 'Live sled force (e2e)',
        config: { mode: 'lorentz-sled' },
        steps: [
          { at: 0, set: { drive: 1, 'lorentz-sled.fieldT': 0.4 } },
          { at: 0, record: ['lorentzFieldT', 'lorentzForceN'], hz: 10, until: 0.6 },
          { at: 0.6, expect: [
            { stat: { key: 'lorentzFieldT', of: 'last', approx: 0.4, rel: 0.01 } },
            { stat: { key: 'lorentzForceN', of: 'max', gt: 0 } }
          ] }
        ]
      };
      window.lab.runExperiment(def, { runner: 'live' })
        .then((run) => { window.__e2eLive = { run }; })
        .catch((err) => { window.__e2eLive = { error: String(err?.message ?? err) }; });
    });
    await waitForEval(page, () => window.__e2eLive != null, { timeout: 300_000, intervalMs: 1000 });
    const live = await page.evaluate(() => {
      const r = window.__e2eLive;
      if (r.error) return { error: r.error };
      const run = r.run;
      const t = run.rows.map((row) => row[0]);
      return {
        runner: run.runner,
        rows: run.rows.length,
        t0: t[0],
        tLast: t[t.length - 1],
        monotonic: t.every((x, i) => i === 0 || x > t[i - 1]),
        expects: run.expects.map((e) => ({ label: e.label, pass: e.pass, measured: e.measured })),
        clockCleared: window.multiVisualizer?.session?.experimentClock == null
      };
    });
    expect(live.error, live.error).toBeUndefined();
    expect(live.runner).toBe('live');
    // One row per 0.1 s tick, however slow the frames were.
    expect(live.rows).toBeGreaterThanOrEqual(6);
    expect(live.t0).toBeLessThan(0.2);
    expect(live.tLast).toBeGreaterThan(0.55);
    expect(live.monotonic, 'rows carry increasing simulated time').toBe(true);
    expect(live.expects.every((e) => e.pass), JSON.stringify(live.expects)).toBe(true);
    expect(live.clockCleared, 'a finished run releases the session clock').toBe(true);

    // Panel: the dashboard button lazy-loads it with every shipped experiment.
    await page.evaluate(() => /** @type {HTMLButtonElement} */ (document.getElementById('experimentsOpenBtn')).click());
    await waitForEval(page, () => (document.querySelector('#lab-experiment-panel select')?.options.length ?? 0) >= 4,
      { timeout: 90_000 });
    const panel = await page.evaluate(() => {
      const dialog = /** @type {HTMLDialogElement} */ (document.getElementById('lab-experiment-panel'));
      const select = /** @type {HTMLSelectElement} */ (dialog.querySelector('select'));
      return {
        open: dialog.open,
        ids: [...select.options].map((o) => o.value),
        text: dialog.textContent ?? ''
      };
    });
    expect(panel.open).toBe(true);
    expect(panel.ids).toEqual(expect.arrayContaining([
      'lorentz-force-vs-field', 'homopolar-emf-vs-rpm', 'transformer-turns-ratio', 'hall-voltage-vs-field'
    ]));
    expect(panel.text).toContain('Simulated, not metrology');

    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });
});
