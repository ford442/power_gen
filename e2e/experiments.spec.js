// @ts-check
import { readFileSync } from 'node:fs';
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
  test('a 12-point sweep runs in the offline worker pool and exports one CSV', async ({ page }) => {
    // 12 workers (a few at a time) each load the bench graph from the dev server.
    test.setTimeout(900_000);
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => typeof window.lab?.runExperiment === 'function' && typeof window.openAnalysis === 'function',
      { timeout: 90_000 });

    // Count the experiment workers the sweep pool opens, and how many at once.
    await page.evaluate(() => {
      const Base = window.Worker;
      const stats = { opened: 0, live: 0, maxLive: 0 };
      window.__e2eWorkers = stats;
      window.Worker = class extends Base {
        constructor(url, opts) {
          super(url, opts);
          if (!String(url).includes('experiment-worker')) return;
          stats.opened++;
          stats.live++;
          stats.maxLive = Math.max(stats.maxLive, stats.live);
          const terminate = this.terminate.bind(this);
          this.terminate = () => { stats.live--; terminate(); };
        }
      };
      window.__e2eSweep = null;
      const def = {
        id: 'e2e-sweep-12',
        title: 'Sled force over 12 fields (e2e)',
        config: { mode: 'lorentz-sled' },
        duration: 1,
        steps: [
          { at: 0, set: { drive: 1 } },
          { at: 0, record: ['lorentzFieldT', 'lorentzForceN'], hz: 20, until: 1 }
        ],
        sweep: { 'lorentz-sled.fieldT': { from: 0.05, to: 0.6, n: 12 } },
        summary: { from: 0.5, until: 1, of: 'mean' },
        summaryExpect: [{ stat: { key: 'lorentzForceN', of: 'max', gt: 0 } }],
        plots: [{ x: 'lorentzFieldT', y: 'lorentzForceN', fit: 'linear' }]
      };
      window.lab.runExperiment(def, { runner: 'offline' })
        .then((run) => { window.__e2eSweep = { run }; })
        .catch((err) => { window.__e2eSweep = { error: String(err?.message ?? err) }; });
    });
    await waitForEval(page, () => window.__e2eSweep != null, { timeout: 600_000, intervalMs: 2000 });
    const sweep = await page.evaluate(() => {
      const r = window.__e2eSweep;
      if (r.error) return { error: r.error };
      return {
        id: r.run.id,
        runner: r.run.runner,
        columns: r.run.columns,
        rows: r.run.rows,
        expects: r.run.expects.map((e) => e.pass),
        workers: window.__e2eWorkers,
        cap: Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1))
      };
    });
    expect(sweep.error, sweep.error).toBeUndefined();
    expect(sweep.runner).toBe('offline');
    expect(sweep.rows.length).toBe(12);
    expect(sweep.columns[0]).toBe('lorentz-sled.lorentzField');
    expect(sweep.expects).toEqual([true]);
    // One worker per point, never more at once than the pool allows.
    expect(sweep.workers.opened).toBe(12);
    expect(sweep.workers.maxLive).toBeGreaterThanOrEqual(1);
    expect(sweep.workers.maxLive).toBeLessThanOrEqual(sweep.cap);
    expect(sweep.workers.live).toBe(0);
    // The summary row's field is the sweep value; force rises with it.
    const fj = sweep.columns.indexOf('lorentzForceN');
    expect(sweep.rows[11][fj]).toBeGreaterThan(sweep.rows[0][fj]);

    // The analysis panel's CSV of the summary: one file, 12 data rows.
    await page.evaluate((id) => window.openAnalysis([id]), sweep.id);
    await waitForEval(page, () => !!document.querySelector('#analysis-panel:not([hidden]) .uplot canvas'), { timeout: 90_000 });
    const download = page.waitForEvent('download', { timeout: 60_000 });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('#analysis-panel button')].find((b) => b.textContent === 'CSV');
      /** @type {HTMLButtonElement} */ (btn).click();
    });
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^seg-run-e2e-sweep-12-sweep-[\w.-]+\.csv$/);
    const csv = readFileSync(/** @type {string} */ (await file.path()), 'utf8');
    const lines = csv.trim().split('\n');
    const comments = lines.filter((l) => l.startsWith('#'));
    const data = lines.filter((l) => !l.startsWith('#'));
    expect(comments.join('\n')).toContain('not metrology');
    expect(comments.join('\n')).toMatch(/# expect: PASS /);
    expect(data[0].split(',')).toEqual(sweep.columns);
    expect(data.length).toBe(1 + 12);
    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });

  test('a shipped reference passes live on the WebGL2 frame loop (JS plants on the session clock)', async ({ page }) => {
    // ~11 s of simulated time cut at every 30 Hz record tick: ~340 frames of SwiftShader.
    test.setTimeout(900_000);
    await page.setViewportSize({ width: 480, height: 320 });
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => typeof window.lab?.runExperiment === 'function', { timeout: 90_000 });
    // Leave the lab in a state the run must not inherit: the field bus on (the
    // sled would follow the MHD estimate instead of its own B).
    await page.evaluate(() => window.setFieldCoupling?.(true));
    await page.evaluate(() => {
      window.__e2eRef = null;
      window.lab.runExperiment('lorentz-force-vs-field', { runner: 'live' })
        .then((run) => { window.__e2eRef = { run }; })
        .catch((err) => { window.__e2eRef = { error: String(err?.message ?? err) }; });
    });
    await waitForEval(page, () => window.__e2eRef != null, { timeout: 840_000, intervalMs: 2000 });
    // The same file offline on the same (JS) plant, in the worker: the golden
    // the live samples must follow row by row.
    await page.evaluate(() => {
      window.__e2eRefOffline = null;
      window.lab.runExperiment('lorentz-force-vs-field', { runner: 'offline', wasm: false, store: false })
        .then((run) => { window.__e2eRefOffline = { run }; })
        .catch((err) => { window.__e2eRefOffline = { error: String(err?.message ?? err) }; });
    });
    await waitForEval(page, () => window.__e2eRefOffline != null, { timeout: 300_000, intervalMs: 1000 });
    const ref = await page.evaluate(() => {
      const r = window.__e2eRef;
      const o = window.__e2eRefOffline;
      if (r.error || o.error) return { error: r.error ?? o.error };
      const t = r.run.rows.map((row) => row[0]);
      // RMS gap of the sled speed (a transient: it lags the B ramp) over rows
      // matched on t, as a fraction of its range.
      const key = 'lorentzSledVms';
      const lj = r.run.columns.indexOf(key);
      const oj = o.run.columns.indexOf(key);
      const byT = new Map(o.run.rows.map((row) => [row[0].toFixed(6), row[oj]]));
      const ov = o.run.rows.map((row) => row[oj]);
      const range = Math.max(...ov) - Math.min(...ov);
      let sq = 0;
      let matched = 0;
      for (const row of r.run.rows) {
        const ref = byT.get(row[0].toFixed(6));
        if (ref === undefined) continue;
        matched++;
        sq += (row[lj] - ref) ** 2;
      }
      return {
        runner: r.run.runner,
        backend: r.run.backend,
        offlineBackend: o.run.backend,
        rows: r.run.rows.length,
        tLast: t[t.length - 1],
        expects: r.run.expects.map((e) => ({ label: e.label, pass: e.pass, measured: e.measured })),
        fieldCoupling: window.multiVisualizer?.fieldNetwork?.couplingEnabled,
        speedGap: matched ? Math.sqrt(sq / matched) / range : null,
        matched,
        offlineRows: o.run.rows.length
      };
    });
    expect(ref.error, ref.error).toBeUndefined();
    expect(ref.runner).toBe('live');
    expect(ref.backend).toBe('js');
    // 10 s at 30 Hz, both ends.
    expect(ref.rows).toBeGreaterThanOrEqual(300);
    expect(ref.tLast).toBeGreaterThan(10.9);
    expect(ref.expects.every((e) => e.pass), JSON.stringify(ref.expects)).toBe(true);
    // The offline numbers (docs/EXPERIMENTS.md: slope 4.53 N/T, F_max 2.72 N)
    // — the JS sled stepped the session's cut batches, not frame time.
    const fit = ref.expects.find((e) => e.measured?.slope != null);
    expect(fit.measured.slope).toBeGreaterThan(4.53 * 0.98);
    expect(fit.measured.slope).toBeLessThan(4.53 * 1.02);
    // The samples follow the offline run row by row: the sled's speed is a
    // transient (it lags the B ramp), so a JS plant that stepped frame time
    // instead of the session's cut batch drifts off it. Measured on
    // SwiftShader: ~0.09 % of range on the session clock, ~3.2 % when the
    // plant stepped frame time.
    console.log(`[e2e] live lorentz-force-vs-field: sled speed rms gap ${(100 * ref.speedGap).toFixed(3)} % of range over ${ref.matched} rows`);
    expect(ref.offlineBackend).toBe('js');
    expect(ref.matched).toBeGreaterThanOrEqual(0.9 * ref.offlineRows);
    expect(ref.speedGap, `sled speed rms gap ${ref.speedGap}`).toBeLessThan(0.01);
    // The run started from the bench config (coupling off), as offline does.
    expect(ref.fieldCoupling).toBe(false);
    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });
});
