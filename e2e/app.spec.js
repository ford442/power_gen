// @ts-check
import { test, expect } from '@playwright/test';
import { gotoWebGL2, trackPageErrors } from './helpers.js';

test.describe('SEG WebGL2 smoke', () => {
  test.afterEach(async ({ page }) => {
    await page.close();
  });

  test('page load has no uncaught errors and #gpuCanvas is present', async ({ page }) => {
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);

    await expect(page.locator('#gpuCanvas')).toBeAttached();
    await expect(page.locator('#gpuCanvas')).toHaveAttribute('data-renderer', 'webgl2');

    await page.waitForFunction(
      () => document.getElementById('fps')?.textContent !== '--',
      { timeout: 10_000 }
    ).catch(() => {});
    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });

  test('START plant reports rpm > 0 within 5s', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    await page.evaluate(() => window.segOperator.start());

    await page.waitForFunction(
      () => {
        const rpm = window.getRendererInfo()?.telemetry?.rpm ?? 0;
        return rpm > 0;
      },
      { timeout: 5_000 }
    );

    const rpm = await page.evaluate(() => window.getRendererInfo().telemetry.rpm);
    expect(rpm).toBeGreaterThan(0);
  });

  test("setMode('seg') focuses SEG view", async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    await page.evaluate(() => {
      window.setMode('heron');
      window.setMode('seg');
    });

    const view = await page.evaluate(() => window.getRendererInfo().view);
    expect(view).toBe('seg');
    await expect(page.locator('#btn-seg')).toHaveClass(/active/);
  });

  test('?prototype=lab sets lab preset and Roschin layout', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'prototype=lab');

    const info = await page.evaluate(() => window.getRendererInfo());
    expect(info.prototypePreset).toBe('lab');
    expect(info.anomalousEffectsEnabled).toBe(true);
    expect(info.segLayoutPreset).toBe('roschin');
    expect(info.intentionalGaps).toContain('Roschin–Godin magnetic wall shells');
  });

  test('captureCanvasFrame returns RGBA buffer matching canvas size', async ({ page }) => {
    trackPageErrors(page);
    await page.setViewportSize({ width: 960, height: 540 });
    await gotoWebGL2(page);

    const frame = await page.evaluate(() => {
      const canvas = document.querySelector('#gpuCanvas');
      const shot = window.captureCanvasFrame({ flipY: true, flush: false });
      return {
        width: shot.width,
        height: shot.height,
        pixelBytes: shot.pixels.length,
        format: shot.format,
        origin: shot.origin,
        renderer: shot.renderer,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
      };
    });

    expect(frame.format).toBe('RGBA8');
    expect(frame.origin).toBe('top-left');
    expect(frame.renderer).toBe('webgl2');
    expect(frame.width).toBe(frame.canvasWidth);
    expect(frame.height).toBe(frame.canvasHeight);
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBeGreaterThan(0);
    expect(frame.pixelBytes).toBe(frame.width * frame.height * 4);
  });
});

test.describe('WASM physics (optional)', () => {
  test.afterEach(async ({ page }) => {
    await page.close();
  });

  test('?wasmPhysics=1 enables segWasm and shows loaded WASM badge', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'wasmPhysics=1');

    await page.waitForFunction(
      () => document.getElementById('wasmStatus')?.textContent === 'WASM ✓',
      { timeout: 20_000 }
    );

    await page.waitForFunction(
      () => window.segWasm?.enabled === true && window.getRendererInfo()?.wasmPhysics === true,
      { timeout: 10_000 }
    );

    const wasm = await page.evaluate(() => ({
      segWasmEnabled: window.segWasm?.enabled === true,
      wasmPhysics: window.getRendererInfo()?.wasmPhysics === true,
      badgeText: document.getElementById('wasmStatus')?.textContent ?? '',
      badgeLoaded: document.getElementById('wasmDot')?.classList.contains('loaded') ?? false,
    }));

    expect(wasm.badgeText).toBe('WASM ✓');
    expect(wasm.badgeLoaded).toBe(true);
    expect(wasm.segWasmEnabled).toBe(true);
    expect(wasm.wasmPhysics).toBe(true);
  });
});
