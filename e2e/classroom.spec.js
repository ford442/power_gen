// @ts-check
/**
 * Classroom delivery (#224 §5): touch camera, video recording, Record control.
 * The offline PWA half needs a production build — see e2e/offline.preview.js
 * (`npm run test:e2e:offline`).
 */
import { test, expect } from '@playwright/test';
import { gotoWebGL2, trackPageErrors, waitForEval } from './helpers.js';

// SwiftShader frames scale with pixels; a smaller canvas keeps rAF (which the
// recorder rides on) from starving. Waits are long: a loaded CI box can take
// seconds per frame, and every page.evaluate queues behind one.
test.use({ viewport: { width: 800, height: 500 } });
test.setTimeout(480_000);

/**
 * Dispatch synthetic touch PointerEvents on #gpuCanvas, in one task.
 * Each step is [type, pointerId, fx, fy] with fx/fy as canvas fractions.
 * @param {import('@playwright/test').Page} page
 * @param {Array<[string, number, number, number]>} steps
 */
function touch(page, steps) {
  return page.evaluate((evs) => {
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('gpuCanvas'));
    const r = canvas.getBoundingClientRect();
    for (const [type, id, fx, fy] of evs) {
      canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: id,
        pointerType: 'touch',
        isPrimary: id === 1,
        clientX: r.left + fx * r.width,
        clientY: r.top + fy * r.height,
        button: type === 'pointermove' ? -1 : 0,
        buttons: type === 'pointerup' ? 0 : 1,
        bubbles: true,
        cancelable: true
      }));
    }
  }, steps);
}

/** Camera readout: eye–target distance, yaw about the lab's vertical axis, target, view. */
function camera(page) {
  return page.evaluate(() => {
    const v = /** @type {any} */ (window.multiVisualizer);
    const c = v.cameraController.camera;
    const d = c.position.map((/** @type {number} */ p, /** @type {number} */ i) => p - c.target[i]);
    return {
      dist: Math.hypot(...d),
      yaw: Math.atan2(c.position[2], c.position[0]),
      target: [...c.target],
      view: v.currentView,
      moving: c.transitionActive
    };
  });
}

/** Linear one- or two-finger path, `n` moves. */
function path(id, from, to, n = 8) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push(['pointermove', id, from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n]);
  }
  return out;
}

test.describe('classroom: touch camera', () => {
  test.use({ hasTouch: true });

  test('double-tap focuses, one finger orbits, pinch zooms, two fingers pan', async ({ page }) => {
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => {
      const c = /** @type {any} */ (window.multiVisualizer)?.cameraController?.camera;
      return !!c && !c.transitionActive && window.multiVisualizer?.currentView === 'overview';
    }, { timeout: 60_000 });

    // Double-tap the SEG bench (projected from its config position) → focus.
    const seg = await page.evaluate(() => {
      const v = /** @type {any} */ (window.multiVisualizer);
      const p = v.devices.seg.config.position;
      const m = v.cameraController.getViewProjMatrix();
      const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      return {
        fx: ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w + 1) / 2,
        fy: (1 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) / 2
      };
    });
    const tap = (fx, fy) => [['pointerdown', 1, fx, fy], ['pointerup', 1, fx, fy]];
    await touch(page, [...tap(seg.fx, seg.fy), ...tap(seg.fx, seg.fy)]);
    // The first touch fetches the lazy camera-touch chunk; queued events replay.
    await waitForEval(page, () => window.multiVisualizer?.currentView === 'seg', { timeout: 120_000 });

    // Double-tap anywhere in a device view → back to the overview.
    await touch(page, [...tap(0.5, 0.5), ...tap(0.5, 0.5)]);
    await waitForEval(page, () => window.multiVisualizer?.currentView === 'overview', { timeout: 120_000 });
    await waitForEval(page, () => !(/** @type {any} */ (window.multiVisualizer).cameraController.camera.transitionActive),
      { timeout: 120_000 });

    // Pinch out (span ×3) → closer; per-sample clamp still lands near ÷3.
    const c0 = await camera(page);
    await touch(page, [
      ['pointerdown', 1, 0.45, 0.5], ['pointerdown', 2, 0.55, 0.5],
      ...path(1, [0.45, 0.5], [0.35, 0.5]).flatMap((m, i) => [m, path(2, [0.55, 0.5], [0.65, 0.5])[i]]),
      ['pointerup', 1, 0.35, 0.5], ['pointerup', 2, 0.65, 0.5]
    ]);
    const c1 = await camera(page);
    expect(c1.dist, `distance ${c0.dist} → ${c1.dist}`).toBeLessThan(c0.dist * 0.5);
    expect(c1.dist).toBeGreaterThan(c0.dist * 0.2);

    // Two fingers sliding together → pan (target moves, distance kept).
    await touch(page, [
      ['pointerdown', 1, 0.4, 0.5], ['pointerdown', 2, 0.6, 0.5],
      ...path(1, [0.4, 0.5], [0.5, 0.5]).flatMap((m, i) => [m, path(2, [0.6, 0.5], [0.7, 0.5])[i]]),
      ['pointerup', 1, 0.5, 0.5], ['pointerup', 2, 0.7, 0.5]
    ]);
    const c2 = await camera(page);
    const moved = Math.hypot(...c2.target.map((t, i) => t - c1.target[i]));
    expect(moved, `target ${c1.target} → ${c2.target}`).toBeGreaterThan(0.05);
    expect(Math.abs(c2.dist - c1.dist)).toBeLessThan(1e-6 + c1.dist * 1e-6);

    // One-finger drag → orbit (yaw changes). Last on purpose: the shared
    // CameraController.orbit() pulls the eye toward the world origin on every
    // step (pre-existing, mouse too — docs/CLASSROOM.md), so distances measured
    // after an orbit say nothing about touch.
    await touch(page, [['pointerdown', 1, 0.3, 0.5], ...path(1, [0.3, 0.5], [0.5, 0.5]), ['pointerup', 1, 0.5, 0.5]]);
    const c3 = await camera(page);
    expect(Math.abs(c3.yaw - c2.yaw), `yaw ${c2.yaw} → ${c3.yaw}`).toBeGreaterThan(0.3);
    expect(c3.view).toBe('overview');

    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });
});

test.describe('classroom: recording', () => {
  test('window.recordBench(2) resolves a non-empty video Blob; a second call while busy rejects', async ({ page }) => {
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => typeof window.recordBench === 'function', { timeout: 60_000 });
    const res = await page.evaluate(async () => {
      const first = window.recordBench(2);
      const second = await window.recordBench(2).then(() => 'resolved', (e) => String(e?.message ?? e));
      const blob = await first;
      return { size: blob.size, type: blob.type, second };
    });
    expect(res.size).toBeGreaterThan(0);
    expect(res.type).toMatch(/^video\/(webm|mp4)/);
    expect(res.second).toMatch(/already running/);
    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });

  test('Record control fits a 390 px viewport and saves seg-lab-<timestamp>.webm', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoWebGL2(page);
    await waitForEval(page, () => document.querySelectorAll('#classroomRecord [data-rec-seconds]').length === 3,
      { timeout: 60_000 });
    const layout = await page.evaluate(() => {
      const wrap = /** @type {HTMLElement} */ (document.getElementById('classroomRecord'));
      const panel = /** @type {HTMLElement} */ (wrap.closest('.panel-section'));
      const left = /** @type {HTMLElement} */ (document.getElementById('left-panel'));
      const p = panel.getBoundingClientRect();
      const buttons = [...wrap.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
      const widths = () => [left.scrollWidth, document.documentElement.scrollWidth];
      const withRow = widths();
      wrap.style.display = 'none';
      const withoutRow = widths();
      wrap.style.display = '';
      return {
        labels: [...wrap.querySelectorAll('button')].map((b) => b.textContent),
        inside: buttons.every((b) => b.left >= p.left - 1 && b.right <= p.right + 1),
        withRow,
        withoutRow
      };
    });
    expect(layout.labels).toEqual(['● 10s', '● 30s', '● 60s']);
    expect(layout.inside, 'Record buttons overflow their panel at 390 px').toBe(true);
    // The 390 px shell already overflows a little (header, sci panel); the
    // Record row must not add to it.
    expect(layout.withRow, 'the Record row widens the page at 390 px').toEqual(layout.withoutRow);

    // Start a 10 s clip, stop it after ~1.5 s: the partial clip still downloads.
    const download = page.waitForEvent('download', { timeout: 180_000 });
    await page.evaluate(() => /** @type {HTMLButtonElement} */ (document.querySelector('[data-rec-seconds="10"]')).click());
    await waitForEval(page, () => document.querySelector('[data-rec-seconds="10"]')?.textContent === '■ Stop',
      { timeout: 120_000 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.evaluate(() => /** @type {HTMLButtonElement} */ (document.querySelector('[data-rec-seconds="10"]')).click());
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^seg-lab-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.(webm|mp4)$/);
    await waitForEval(page, () => /Saved seg-lab-/.test(document.querySelector('#classroomRecord [role="status"]')?.textContent ?? ''),
      { timeout: 120_000 });
  });
});
