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

test.describe('Hardware twin mock', () => {
  test.afterEach(async ({ page }) => {
    await page.close();
  });

  test('?mockHardware=1 publishes shadowResidual on TelemetryHub', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'mockHardware=1');

    await page.waitForFunction(
      () => window.getRendererInfo()?.hardwareTwin?.connected === true,
      { timeout: 10_000 }
    );

    await page.evaluate(() => {
      const bridge = window.multiVisualizer?.hardwareBridge
        || window.currentVisualizer?.hardwareBridge;
      // Prefer shadow so residual semantics match docs; mock auto-sets this.
      bridge?.setTwinMode?.('shadow');
      window.segOperator.start();
    });

    await page.waitForFunction(
      () => {
        const ht = window.getRendererInfo()?.hardwareTwin;
        return ht?.connected === true
          && ht.shadowResidual
          && typeof ht.shadowResidual.phaseErrorDeg === 'number'
          && typeof ht.shadowResidual.rpmError === 'number';
      },
      { timeout: 8_000 }
    );

    const twin = await page.evaluate(() => {
      const info = window.getRendererInfo();
      const hub = window.telemetryHub?.getSnapshot?.()
        ?? null;
      return {
        info: info.hardwareTwin,
        hub: hub?.hardwareTwin ?? null,
        mock: info.hardwareTwin?.mock === true,
        twinMode: info.hardwareTwin?.twinMode
      };
    });

    expect(twin.info).toBeTruthy();
    expect(twin.info.connected).toBe(true);
    expect(twin.info.mock).toBe(true);
    expect(twin.info.shadowResidual).toEqual(
      expect.objectContaining({
        phaseErrorDeg: expect.any(Number),
        rpmError: expect.any(Number)
      })
    );
    expect(twin.hub?.shadowResidual).toEqual(
      expect.objectContaining({
        phaseErrorDeg: expect.any(Number),
        rpmError: expect.any(Number),
        voltageError: expect.any(Number),
        currentError: expect.any(Number)
      })
    );
  });

  test('disconnect coasts coils — no manual override after disconnect', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'mockHardware=1');

    await page.waitForFunction(
      () => window.multiVisualizer?.hardwareBridge?.isConnected === true,
      { timeout: 10_000 }
    );

    await page.evaluate(() => {
      const b = window.multiVisualizer.hardwareBridge;
      b.setManualCoils(0b11, 0.75);
    });

    await page.evaluate(async () => {
      await window.multiVisualizer.hardwareBridge.disconnect();
    });

    const state = await page.evaluate(() => {
      const b = window.multiVisualizer?.hardwareBridge;
      return {
        status: b?.status,
        manualMode: b?.manualMode,
        pwmDuty: b?.manualPwmDuty,
        connectionKind: b?.connectionKind
      };
    });

    expect(state.status).toBe('disconnected');
    expect(state.connectionKind).toBe('disconnected');
    expect(state.manualMode).toBe(false);
    expect(state.pwmDuty).toBe(0);
  });

  test('scientific UI shows shadow residual chart with mockHardware', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'mockHardware=1');

    await page.waitForFunction(
      () => window.multiVisualizer?.hardwareBridge?.isConnected === true,
      { timeout: 10_000 }
    );

    await page.evaluate(() => {
      window.segOperator.start();
      window.sciUI?.show?.();
    });

    await page.waitForFunction(
      () => document.getElementById('sci-shadow-residual-gauge') != null
        && window.telemetryHub?.getSnapshot?.()?.hardwareTwin?.connected === true,
      { timeout: 8_000 }
    );

    const chart = await page.evaluate(() => {
      const el = document.getElementById('sci-shadow-residual-gauge');
      const twin = window.telemetryHub.getSnapshot().hardwareTwin;
      return {
        hasCanvas: !!el?.querySelector('canvas'),
        connectionState: twin?.connectionState,
        rpmErr: twin?.shadowResidual?.rpmError
      };
    });

    expect(chart.hasCanvas).toBe(true);
    expect(chart.connectionState).toBe('mock');
    expect(typeof chart.rpmErr).toBe('number');
  });

  test('energyCoupling=1 shows residual W in overview disclaimer', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'energyCoupling=1');

    await page.evaluate(() => {
      window.setMode('overview');
      document.body.classList.add('overview-mode');
    });

    await page.waitForFunction(
      () => {
        const el = document.getElementById('energyNetworkDisclaimer');
        return el?.dataset.mode === 'coupled' && el.textContent.includes('residual');
      },
      { timeout: 8_000 }
    );

    const disc = await page.evaluate(() => {
      const el = document.getElementById('energyNetworkDisclaimer');
      return { mode: el?.dataset.mode, text: el?.textContent ?? '' };
    });

    expect(disc.mode).toBe('coupled');
    expect(disc.text).toMatch(/residual/i);
    expect(disc.text).toMatch(/not metrology/i);
  });
});
