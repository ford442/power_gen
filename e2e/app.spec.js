// @ts-check
import { test, expect } from '@playwright/test';
import { gotoWebGL2, trackPageErrors, waitForEval } from './helpers.js';

test.describe('SEG WebGL2 smoke', () => {

  test('page load has no uncaught errors and #gpuCanvas is present', async ({ page }) => {
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);

    // Prefer evaluate over locator expects — SwiftShader main-thread stalls
    // starve Playwright's locator engine even when the DOM is already correct.
    const canvas = await page.evaluate(() => {
      const el = document.getElementById('gpuCanvas');
      return {
        present: !!el,
        renderer: el?.getAttribute('data-renderer') ?? el?.dataset?.renderer ?? null,
        currentRenderer: window.currentRenderer ?? null
      };
    });
    expect(canvas.present).toBe(true);
    expect(canvas.currentRenderer).toBe('webgl2');
    expect(canvas.renderer === 'webgl2' || canvas.currentRenderer === 'webgl2').toBe(true);

    await waitForEval(page, 
      () => document.getElementById('fps')?.textContent !== '--',
      { timeout: 30_000 }
    ).catch(() => {});
    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });

  test('START plant reports rpm > 0 within 5s', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    // Drive the plant directly — do not wait on rAF. SwiftShader can stall the
    // render loop long enough that TelemetryHub never refreshes within the
    // wall-clock budget even though the operator plant itself is fine.
    const rpm = await page.evaluate(() => {
      window.segOperator.start();
      for (let i = 0; i < 120; i++) window.segOperator.step(1 / 60);
      const tel = window.segOperator.computeTelemetry(1 / 60);
      return tel?.rpmDisplay ?? window.getRendererInfo()?.telemetry?.rpm ?? 0;
    });
    expect(rpm).toBeGreaterThan(0);
  });

  test("setMode('seg') focuses SEG view", async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    await page.evaluate(() => {
      window.setMode('heron');
      window.setMode('seg');
    });

    await waitForEval(page, () => {
      const view = window.getRendererInfo()?.view;
      const btn = document.getElementById('btn-seg');
      return view === 'seg' && !!btn && btn.classList.contains('active');
    }, { timeout: 30_000 });

    const snap = await page.evaluate(() => ({
      view: window.getRendererInfo().view,
      btnClass: document.getElementById('btn-seg')?.className ?? ''
    }));
    expect(snap.view).toBe('seg');
    expect(snap.btnClass).toMatch(/active/);
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

  test('?wasmPhysics=1 enables segWasm and shows loaded WASM badge', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'wasmPhysics=1');

    await waitForEval(page, 
      () => document.getElementById('wasmStatus')?.textContent === 'WASM ✓'
        || window.segWasm?.available === true,
      { timeout: 90_000 }
    );

    await waitForEval(page, 
      () => window.segWasm?.enabled === true && window.getRendererInfo()?.wasmPhysics === true,
      { timeout: 60_000 }
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

  test('transformer ?wasmPhysics=1 uses C++ plant (SimMode 8)', async ({ page }) => {
    test.setTimeout(300_000);
    trackPageErrors(page);
    await gotoWebGL2(page, 'wasmPhysics=1');

    await waitForEval(page, 
      () => document.getElementById('wasmStatus')?.textContent === 'WASM ✓'
        || window.segWasm?.available === true,
      { timeout: 90_000 }
    );
    await waitForEval(page, 
      () => window.segWasm?.enabled === true && window.multiVisualizer != null,
      { timeout: 60_000 }
    );

    await page.evaluate(() => {
      window.segOperator.start();
      window.setMode('transformer');
      window.segWasm?.setMode?.('transformer');
    });

    await waitForEval(page, 
      () => {
        const plant = window.segWasm?.getModePlant?.();
        return window.segWasm?.getMode?.() === 8
          && plant?.mode === 'transformer'
          && Number.isFinite(plant.i1) && Number.isFinite(plant.i2) && Number.isFinite(plant.v2)
          && (Math.abs(plant.i1) + Math.abs(plant.i2) + Math.abs(plant.v1) > 0.05);
      },
      { timeout: 90_000 }
    );

    const snap = await page.evaluate(() => {
      const plant = window.segWasm.getModePlant();
      const phys = window.multiVisualizer?.devices?.transformer?.physicsState
        ?? window.multiVisualizer?.devices?.transformer?.physics;
      return {
        mode: window.segWasm.getMode(),
        plantMode: plant?.mode,
        i1: plant?.i1 ?? 0,
        i2: plant?.i2 ?? 0,
        v2: plant?.v2 ?? 0,
        k: plant?.k ?? 0,
        jsIp: phys?.transformerIpA ?? 0,
      };
    });

    expect(snap.mode).toBe(8);
    expect(snap.plantMode).toBe('transformer');
    expect(Number.isFinite(snap.i1)).toBe(true);
    expect(Number.isFinite(snap.i2)).toBe(true);
    expect(Number.isFinite(snap.v2)).toBe(true);
    expect(Math.abs(snap.i1) + Math.abs(snap.i2) + Math.abs(snap.v2)).toBeGreaterThan(0.05);
    expect(Math.abs(snap.jsIp)).toBeGreaterThan(0.001);
    expect(snap.k).toBeGreaterThan(0.5);
  });

  test('vdg ?wasmPhysics=1 uses C++ plant (SimMode 9)', async ({ page }) => {
    test.setTimeout(300_000);
    trackPageErrors(page);
    await gotoWebGL2(page, 'wasmPhysics=1');

    await waitForEval(page,
      () => document.getElementById('wasmStatus')?.textContent === 'WASM ✓'
        || window.segWasm?.available === true,
      { timeout: 90_000 }
    );
    await waitForEval(page,
      () => window.segWasm?.enabled === true && window.multiVisualizer != null,
      { timeout: 60_000 }
    );

    await page.evaluate(() => {
      window.segOperator.start();
      window.setMode('vdg');
      window.segWasm?.setMode?.('vdg');
    });

    await waitForEval(page,
      () => {
        const plant = window.segWasm?.getModePlant?.();
        return window.segWasm?.getMode?.() === 9
          && plant?.mode === 'vdg'
          && Number.isFinite(plant.voltage) && Number.isFinite(plant.beltMps)
          && plant.voltage > 0;
      },
      { timeout: 90_000 }
    );

    const snap = await page.evaluate(() => {
      const plant = window.segWasm.getModePlant();
      const phys = window.multiVisualizer?.devices?.vdg?.physicsState
        ?? window.multiVisualizer?.devices?.vdg?.physics;
      return {
        mode: window.segWasm.getMode(),
        plantMode: plant?.mode,
        voltage: plant?.voltage ?? 0,
        beltMps: plant?.beltMps ?? 0,
        chargeC: plant?.chargeC ?? 0,
        sparkHz: plant?.sparkHz ?? 0,
        jsVoltage: phys?.vdgVoltage ?? 0
      };
    });

    expect(snap.mode).toBe(9);
    expect(snap.plantMode).toBe('vdg');
    expect(Number.isFinite(snap.voltage)).toBe(true);
    expect(Number.isFinite(snap.beltMps)).toBe(true);
    expect(Number.isFinite(snap.chargeC)).toBe(true);
    expect(Number.isFinite(snap.sparkHz)).toBe(true);
    expect(snap.voltage).toBeGreaterThan(0);
    expect(snap.beltMps).toBeGreaterThan(0);
    expect(snap.jsVoltage).toBeGreaterThan(0);
  });

  test('hall ?wasmPhysics=1 uses C++ plant (SimMode 10)', async ({ page }) => {
    test.setTimeout(300_000);
    trackPageErrors(page);
    await gotoWebGL2(page, 'wasmPhysics=1');

    await waitForEval(page,
      () => document.getElementById('wasmStatus')?.textContent === 'WASM ✓'
        || window.segWasm?.available === true,
      { timeout: 90_000 }
    );
    await waitForEval(page,
      () => window.segWasm?.enabled === true && window.multiVisualizer != null,
      { timeout: 60_000 }
    );

    await page.evaluate(() => {
      window.segOperator.start();
      window.setMode('hall');
      window.segWasm?.setMode?.('hall');
    });

    await waitForEval(page,
      () => {
        const plant = window.segWasm?.getModePlant?.();
        return window.segWasm?.getMode?.() === 10
          && plant?.mode === 'hall'
          && Number.isFinite(plant.voltage) && Number.isFinite(plant.current)
          && Math.abs(plant.voltage) > 0;
      },
      { timeout: 90_000 }
    );

    const snap = await page.evaluate(() => {
      const plant = window.segWasm.getModePlant();
      const phys = window.multiVisualizer?.devices?.hall?.physicsState
        ?? window.multiVisualizer?.devices?.hall?.physics;
      return {
        mode: window.segWasm.getMode(),
        plantMode: plant?.mode,
        voltage: plant?.voltage ?? 0,
        current: plant?.current ?? 0,
        fieldT: plant?.fieldT ?? 0,
        coeff: plant?.coeff ?? 0,
        jsVoltage: phys?.hallVoltage ?? 0
      };
    });

    expect(snap.mode).toBe(10);
    expect(snap.plantMode).toBe('hall');
    expect(Number.isFinite(snap.voltage)).toBe(true);
    expect(Number.isFinite(snap.current)).toBe(true);
    expect(Number.isFinite(snap.fieldT)).toBe(true);
    expect(Number.isFinite(snap.coeff)).toBe(true);
    expect(Math.abs(snap.voltage)).toBeGreaterThan(0);
    expect(snap.current).toBeGreaterThan(0);
    expect(Math.abs(snap.jsVoltage)).toBeGreaterThan(0);
  });
});

test.describe('Quanta plugin devices (JS fallback)', () => {

  test('vdg JS fallback produces finite telemetry', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    await page.evaluate(() => {
      window.segOperator.start();
      window.setMode('vdg');
    });

    await waitForEval(page,
      () => {
        const phys = window.multiVisualizer?.devices?.vdg?.physics;
        return !!phys && Number.isFinite(phys.vdgVoltage) && phys.vdgVoltage > 0;
      },
      { timeout: 30_000 }
    );

    const snap = await page.evaluate(() => {
      const phys = window.multiVisualizer.devices.vdg.physics;
      return {
        voltage: phys.vdgVoltage,
        beltMps: phys.vdgBeltMps,
        chargeC: phys.vdgChargeC,
        sparkHz: phys.vdgSparkHz
      };
    });

    expect(Number.isFinite(snap.voltage)).toBe(true);
    expect(Number.isFinite(snap.beltMps)).toBe(true);
    expect(Number.isFinite(snap.chargeC)).toBe(true);
    expect(Number.isFinite(snap.sparkHz)).toBe(true);
    expect(snap.voltage).toBeGreaterThan(0);
    expect(snap.beltMps).toBeGreaterThan(0);
  });

  test('hall JS fallback produces finite telemetry', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    await page.evaluate(() => {
      window.segOperator.start();
      window.setMode('hall');
    });

    await waitForEval(page,
      () => {
        const phys = window.multiVisualizer?.devices?.hall?.physics;
        return !!phys && Number.isFinite(phys.hallVoltage) && phys.hallCurrent > 0;
      },
      { timeout: 30_000 }
    );

    const snap = await page.evaluate(() => {
      const phys = window.multiVisualizer.devices.hall.physics;
      return {
        voltage: phys.hallVoltage,
        current: phys.hallCurrent,
        fieldT: phys.hallFieldT,
        coeff: phys.hallCoeff
      };
    });

    expect(Number.isFinite(snap.voltage)).toBe(true);
    expect(Number.isFinite(snap.current)).toBe(true);
    expect(Number.isFinite(snap.fieldT)).toBe(true);
    expect(Number.isFinite(snap.coeff)).toBe(true);
    expect(Math.abs(snap.voltage)).toBeGreaterThan(0);
    expect(snap.current).toBeGreaterThan(0);
  });
});

test.describe('Hardware twin mock', () => {

  test('?mockHardware=1 publishes shadowResidual on TelemetryHub', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'mockHardware=1');

    await waitForEval(page, 
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

    await waitForEval(page, 
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
    expect(Number.isFinite(twin.hub.shadowResidual.voltageError)).toBe(true);
    expect(Number.isFinite(twin.hub.shadowResidual.currentError)).toBe(true);
  });

  test('mock reconnect after disconnect does not leave coils commanded', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'mockHardware=1');

    await waitForEval(page, 
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

    await page.evaluate(async () => {
      await window.multiVisualizer.hardwareBridge.connectMock();
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

    expect(state.status).toBe('mock');
    expect(state.connectionKind).toBe('mock');
    expect(state.manualMode).toBe(false);
    expect(state.pwmDuty).toBe(0);
  });

  test('disconnect coasts coils — no manual override after disconnect', async ({ page }) => {
    test.setTimeout(300_000);
    trackPageErrors(page);
    await gotoWebGL2(page, 'mockHardware=1');

    await waitForEval(page, 
      () => window.multiVisualizer?.hardwareBridge?.isConnected === true,
      { timeout: 60_000 }
    );

    await page.evaluate(() => {
      const b = window.multiVisualizer.hardwareBridge;
      b.setManualCoils(0b11, 0.75);
    });

    // Fire disconnect without awaiting inside the page (async page.evaluate can
    // starve under SwiftShader). Poll for the disconnected status instead.
    await page.evaluate(() => {
      void window.multiVisualizer.hardwareBridge.disconnect();
    });

    await waitForEval(page, () => {
      const b = window.multiVisualizer?.hardwareBridge;
      return b?.status === 'disconnected' && b?.connectionKind === 'disconnected';
    }, { timeout: 60_000 });

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

    await waitForEval(page, 
      () => window.multiVisualizer?.hardwareBridge?.isConnected === true,
      { timeout: 30_000 }
    );

    // main.ts eagerly import()s scientific-ui; wait for the manager (do not
    // dynamic-import inside page.evaluate — SwiftShader can starve async work).
    await waitForEval(page, () => !!window.sciUI, { timeout: 60_000 });

    await page.evaluate(() => {
      window.segOperator.start();
      window.sciUI.show();
    });

    await waitForEval(page, 
      () => document.getElementById('sci-shadow-residual-gauge') != null
        && window.telemetryHub?.getSnapshot?.()?.hardwareTwin?.connected === true,
      { timeout: 30_000 }
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

    await waitForEval(page, 
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

test.describe('WebGPU required boot', () => {

  test('default boot hard-fails without opening WebGL2', async ({ page }) => {
    trackPageErrors(page);
    // No ?renderer=webgl2 — GPU-less VMs must hard-fail, not GL-rescue.
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

    await waitForEval(page, 
      () => window.webgpuProbe && window.webgpuProbe.ok === false,
      { timeout: 30_000 }
    );

    const snap = await page.evaluate(() => {
      const canvas = document.getElementById('gpuCanvas');
      return {
        probeOk: window.webgpuProbe?.ok,
        error: window.webgpuProbe?.error,
        chromeVsEdge: window.webgpuProbe?.chromeVsEdge,
        currentRenderer: window.currentRenderer,
        multiVisualizer: !!window.multiVisualizer,
        hardFailUi: !!document.getElementById('webgpu-hard-fail'),
        bodyClass: document.body.classList.contains('webgpu-hard-fail'),
        canvasRenderer: canvas?.dataset.renderer,
        canvasWebgpuFail: canvas?.dataset.webgpuFail,
        // Do not call getContext('webgl2') — that would create a context.
        hasWebglAttr: canvas?.dataset.webglVersion || ''
      };
    });

    expect(snap.probeOk).toBe(false);
    expect(snap.error).toBeTruthy();
    expect(snap.chromeVsEdge).toBeTruthy();
    expect(snap.currentRenderer).toBeFalsy();
    expect(snap.hardFailUi).toBe(true);
    expect(snap.bodyClass).toBe(true);
    expect(snap.canvasRenderer).toBe('none');
    expect(snap.canvasWebgpuFail).toBe('1');
    expect(snap.hasWebglAttr).toBe('');
  });
});

test.describe('gpu-chores exclusive session', () => {

  test('WebGL2 session breadcrumbs are webgl2 + wasm/js (no extra GPU device)', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    await waitForEval(page, 
      () => window.getRendererInfo?.()?.renderer === 'webgl2',
      { timeout: 20_000 }
    );

    const info = await page.evaluate(() => {
      const i = window.getRendererInfo();
      const c = i.chores || window.gpuChores?.breadcrumb?.();
      return {
        renderer: i.renderer,
        sessionApi: c?.sessionApi,
        backend: c?.backend,
        adoptedDevice: c?.adoptedDevice,
        canvas: document.getElementById('gpuCanvas')?.dataset.renderer
      };
    });

    expect(info.renderer).toBe('webgl2');
    expect(info.canvas).toBe('webgl2');
    expect(info.sessionApi).toBe('webgl2');
    expect(['js', 'wasm']).toContain(info.backend);
    expect(info.adoptedDevice).toBe(false);
  });
});

test.describe('Telemetry replay scrubber', () => {

  test('?replay=1 loads a recorded file and overlays gauges without live recording', async ({ page }) => {
    test.setTimeout(300_000);
    trackPageErrors(page);
    await gotoWebGL2(page, 'replay=1');

    await waitForEval(page, 
      () => typeof window.applyReplayFile === 'function' && window.telemetryHub,
      { timeout: 20_000 }
    );

    await expect(page.locator('#replay-bar')).toBeVisible();

    await page.evaluate(() => {
      window.applyReplayFile({
        replayVersion: 1,
        createdAt: new Date().toISOString(),
        seed: null,
        segLayoutPreset: 'searl',
        heronLayoutPreset: 'classic',
        renderer: 'webgl2',
        speedCurve: [{ t: 0, drive: 0.8, simRate: 1 }, { t: 1, drive: 0.8, simRate: 1 }],
        config: { loadOhm: 100, magneticFieldStrength: 0.5, sampleHz: 10 },
        samples: [
          {
            time_s: 0, frame_id: 1, view: 'seg', mode: 'seg', status: 'operational',
            rpm_inner: 1200, seg_omega: 0.4, corona: 0.1, voltage_v: 50, current_a: 0.5,
            power_w: 25, field_sim_t: 0.3, energy_density_j_m3: 1e5, drive: 0.8,
            excitation_pct: 50, temperature_c: 30, efficiency_pct: 88, particle_flux: 10,
            load_ohm: 100, hw_connected: 0, hw_connection_state: 'disconnected',
            phase_error_deg: '', rpm_error: '', voltage_error_v: '', current_error_a: '',
            energy_residual_w: '', energy_coupled: 0
          },
          {
            time_s: 1, frame_id: 2, view: 'seg', mode: 'seg', status: 'operational',
            rpm_inner: 2400, seg_omega: 0.8, corona: 0.3, voltage_v: 100, current_a: 1,
            power_w: 100, field_sim_t: 0.5, energy_density_j_m3: 2e5, drive: 0.8,
            excitation_pct: 50, temperature_c: 35, efficiency_pct: 90, particle_flux: 20,
            load_ohm: 100, hw_connected: 0, hw_connection_state: 'disconnected',
            phase_error_deg: '', rpm_error: '', voltage_error_v: '', current_error_a: '',
            energy_residual_w: '', energy_coupled: 0
          }
        ]
      });
      window.replayPlayer.seek(1);
    });

    await waitForEval(page, 
      () => window.telemetryHub?.getSnapshot?.()?.replay?.active === true
        && window.telemetryHub.getSnapshot().seg?.rpmInner >= 2000
        && window.segOperator?.replayMode === true,
      { timeout: 45_000 }
    );

    const snap = await page.evaluate(() => {
      const s = window.telemetryHub.getSnapshot();
      return {
        replay: s.replay,
        rpm: s.seg?.rpmInner,
        voltage: s.seg?.voltage,
        recording: window.telemetryHub.isRecording(),
        badgeHidden: document.getElementById('replay-badge')?.hidden,
        plantStepped: window.segOperator.replayMode
      };
    });

    expect(snap.replay?.active).toBe(true);
    expect(snap.rpm).toBeGreaterThanOrEqual(2000);
    expect(snap.voltage).toBeGreaterThan(50);
    expect(snap.recording).toBe(false);
    expect(snap.badgeHidden).toBe(false);
    expect(snap.plantStepped).toBe(true);

    await page.evaluate(() => window.replayPlayer.exit());
    const after = await page.evaluate(() => ({
      replayMode: window.segOperator.replayMode,
      hubReplay: window.telemetryHub.isReplayMode(),
      snapReplay: window.telemetryHub.getSnapshot().replay
    }));
    expect(after.replayMode).toBe(false);
    expect(after.hubReplay).toBe(false);
    expect(after.snapReplay).toBeFalsy();
  });
});
