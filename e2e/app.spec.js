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

  test('plant worker: START spins the plant off the animation frame', async ({ page }) => {
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);

    // LabSession steps in-loop until the worker reports ready, then hands over.
    await waitForEval(page, () => window.getRendererInfo?.()?.plant?.backend === 'worker', { timeout: 60_000 });
    await page.evaluate(() => window.segOperator.start());
    await waitForEval(page, () => (window.segOperator?.physics?.segOmega ?? 0) > 0.01, { timeout: 60_000 });

    const plant = await page.evaluate(() => window.getRendererInfo().plant);
    expect(plant.backend).toBe('worker');
    expect(plant.fallbackReason).toBeNull();
    expect(plant.latencyFrames).toBe(1);
    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });

  test('?plantWorker=0 keeps the in-loop plant step', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'plantWorker=0');
    await waitForEval(page, () => !!window.getRendererInfo?.()?.plant, { timeout: 60_000 });
    await page.evaluate(() => window.segOperator.start());
    await waitForEval(page, () => (window.segOperator?.physics?.segOmega ?? 0) > 0.01, { timeout: 60_000 });

    const plant = await page.evaluate(() => window.getRendererInfo().plant);
    expect(plant.backend).toBe('in-loop');
    expect(plant.fallbackReason).toBe('?plantWorker=0');
    expect(plant.latencyFrames).toBe(0);
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

  test('WebGL2 context loss shows the reload overlay instead of a silent black canvas', async ({ page }) => {
    const errors = trackPageErrors(page);
    await gotoWebGL2(page);

    const lost = await page.evaluate(() => {
      const gl = document.querySelector('#gpuCanvas').getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_lose_context');
      if (!ext) return false;
      ext.loseContext();
      return true;
    });
    test.skip(!lost, 'WEBGL_lose_context unavailable');

    await waitForEval(page,
      () => document.querySelector('#webgpu-device-lost h2')?.textContent === 'WebGL2 context lost'
        && !!document.getElementById('webgpu-device-lost-reload'),
      { timeout: 10_000 }
    );
    expect(errors.pageErrors).toEqual([]);
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

  test('lorentz-sled ?wasmPhysics=1 uses C++ plant (SimMode 11)', async ({ page }) => {
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
      window.setMode('lorentz-sled');
      window.segWasm?.setMode?.('lorentz-sled');
    });

    await waitForEval(page,
      () => {
        const plant = window.segWasm?.getModePlant?.();
        return window.segWasm?.getMode?.() === 11
          && plant?.mode === 'lorentz-sled'
          && Number.isFinite(plant.currentA) && Number.isFinite(plant.sledVms)
          && plant.sledVms > 0;
      },
      { timeout: 90_000 }
    );

    const snap = await page.evaluate(() => {
      const plant = window.segWasm.getModePlant();
      const phys = window.multiVisualizer?.devices?.['lorentz-sled']?.physicsState
        ?? window.multiVisualizer?.devices?.['lorentz-sled']?.physics;
      return {
        mode: window.segWasm.getMode(),
        plantMode: plant?.mode,
        sledVms: plant?.sledVms ?? 0,
        currentA: plant?.currentA ?? 0,
        fieldT: plant?.fieldT ?? 0,
        forceN: plant?.forceN ?? 0,
        positionM: plant?.positionM ?? 0,
        jsSpeed: phys?.lorentzSledVms ?? 0
      };
    });

    expect(snap.mode).toBe(11);
    expect(snap.plantMode).toBe('lorentz-sled');
    expect(Number.isFinite(snap.sledVms)).toBe(true);
    expect(Number.isFinite(snap.currentA)).toBe(true);
    expect(Number.isFinite(snap.fieldT)).toBe(true);
    expect(Number.isFinite(snap.forceN)).toBe(true);
    expect(Number.isFinite(snap.positionM)).toBe(true);
    expect(snap.sledVms).toBeGreaterThan(0);
    expect(snap.currentA).toBeGreaterThan(0);
    expect(snap.forceN).toBeGreaterThan(0);
    // Reported position wraps at the 2 m rail length.
    expect(snap.positionM).toBeGreaterThanOrEqual(0);
    expect(snap.positionM).toBeLessThanOrEqual(2);
    expect(snap.jsSpeed).toBeGreaterThan(0);
  });

  test('jumping-ring ?wasmPhysics=1 uses C++ plant (SimMode 12)', async ({ page }) => {
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

    // src/public/wasm/sim_core.wasm is a CI artefact committed on main, so a
    // branch checkout can be running a binary built before this plant existed.
    // SEGSimulator::setMode rejects a mode past its own SIM_MODE_COUNT, so an
    // old binary simply will not take 12 — detect that rather than asserting
    // against a plant it does not have. The JS-fallback test below still covers
    // the physics on every checkout.
    //
    // Poll rather than read getMode() straight after setMode(): with the plant
    // worker on, getMode() reports the worker's last plant, which trails the
    // focus change by one frame (docs/AGENTS.md → plant worker).
    await page.evaluate(() => {
      window.segOperator.start();
      window.setMode('jumping-ring');
      window.segWasm?.setMode?.('jumping-ring');
    });
    const accepted = await page
      .waitForFunction(() => window.segWasm?.getMode?.() === 12, null, { timeout: 15_000 })
      .then(() => true, () => false);
    test.skip(!accepted, 'sim_core.wasm predates SimMode 12 (jumping-ring) — rebuilt by build-wasm.yml on main');

    await waitForEval(page,
      () => {
        const plant = window.segWasm?.getModePlant?.();
        return window.segWasm?.getMode?.() === 12
          && plant?.mode === 'jumping-ring'
          && Number.isFinite(plant.ringHeightM) && Number.isFinite(plant.ringCurrentA)
          && plant.ringHeightM > 0;
      },
      { timeout: 90_000 }
    );

    const snap = await page.evaluate(() => {
      const plant = window.segWasm.getModePlant();
      const phys = window.multiVisualizer?.devices?.['jumping-ring']?.physicsState
        ?? window.multiVisualizer?.devices?.['jumping-ring']?.physics;
      return {
        mode: window.segWasm.getMode(),
        plantMode: plant?.mode,
        ringHeightM: plant?.ringHeightM ?? 0,
        ringCurrentA: plant?.ringCurrentA ?? 0,
        ringPrimaryIA: plant?.ringPrimaryIA ?? 0,
        ringForceN: plant?.ringForceN ?? 0,
        ringCouplingK: plant?.ringCouplingK ?? 0,
        jsHeight: phys?.ringHeightM ?? -1
      };
    });

    expect(snap.mode).toBe(12);
    expect(snap.plantMode).toBe('jumping-ring');
    expect(Number.isFinite(snap.ringHeightM)).toBe(true);
    expect(Number.isFinite(snap.ringCurrentA)).toBe(true);
    expect(Number.isFinite(snap.ringPrimaryIA)).toBe(true);
    expect(Number.isFinite(snap.ringForceN)).toBe(true);
    expect(Number.isFinite(snap.ringCouplingK)).toBe(true);
    // The ring has left the core shoulder and is inside the pole stop.
    expect(snap.ringHeightM).toBeGreaterThan(0);
    expect(snap.ringHeightM).toBeLessThanOrEqual(0.15);
    // k(h) has fallen from k0 = 0.65 — that decay is why the ring hovers.
    expect(snap.ringCouplingK).toBeGreaterThan(0);
    expect(snap.ringCouplingK).toBeLessThan(0.65);
    // A current is actually circulating in the shorted ring.
    expect(Math.abs(snap.ringCurrentA)).toBeGreaterThan(1);
    expect(snap.jsHeight).toBeGreaterThan(0);
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

  test('lorentz-sled JS fallback produces finite telemetry', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    await page.evaluate(() => {
      window.segOperator.start();
      window.setMode('lorentz-sled');
    });

    await waitForEval(page,
      () => {
        const phys = window.multiVisualizer?.devices?.['lorentz-sled']?.physics;
        return !!phys && Number.isFinite(phys.lorentzSledVms) && phys.lorentzSledVms > 0;
      },
      { timeout: 30_000 }
    );

    const snap = await page.evaluate(() => {
      const phys = window.multiVisualizer.devices['lorentz-sled'].physics;
      return {
        sledVms: phys.lorentzSledVms,
        currentA: phys.lorentzCurrentA,
        fieldT: phys.lorentzFieldT,
        forceN: phys.lorentzForceN,
        positionM: phys.lorentzPositionM
      };
    });

    expect(Number.isFinite(snap.sledVms)).toBe(true);
    expect(Number.isFinite(snap.currentA)).toBe(true);
    expect(Number.isFinite(snap.fieldT)).toBe(true);
    expect(Number.isFinite(snap.forceN)).toBe(true);
    expect(Number.isFinite(snap.positionM)).toBe(true);
    expect(snap.sledVms).toBeGreaterThan(0);
    expect(snap.currentA).toBeGreaterThan(0);
    expect(snap.forceN).toBeGreaterThan(0);
    expect(snap.positionM).toBeGreaterThanOrEqual(0);
    expect(snap.positionM).toBeLessThanOrEqual(2);
  });

  test('jumping-ring JS fallback lifts the ring and drops k(h)', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    await page.evaluate(() => {
      window.segOperator.start();
      window.setMode('jumping-ring');
    });

    await waitForEval(page,
      () => {
        const phys = window.multiVisualizer?.devices?.['jumping-ring']?.physics;
        return !!phys && Number.isFinite(phys.ringHeightM) && phys.ringHeightM > 0.001;
      },
      { timeout: 30_000 }
    );

    const snap = await page.evaluate(() => {
      const phys = window.multiVisualizer.devices['jumping-ring'].physics;
      return {
        heightM: phys.ringHeightM,
        ringCurrentA: phys.ringCurrentA,
        primaryIA: phys.ringPrimaryIA,
        forceN: phys.ringForceN,
        couplingK: phys.ringCouplingK
      };
    });

    expect(Number.isFinite(snap.heightM)).toBe(true);
    expect(Number.isFinite(snap.ringCurrentA)).toBe(true);
    expect(Number.isFinite(snap.primaryIA)).toBe(true);
    expect(Number.isFinite(snap.forceN)).toBe(true);
    expect(Number.isFinite(snap.couplingK)).toBe(true);
    // The bench's whole claim: the ring leaves the core and stays on the pole.
    expect(snap.heightM).toBeGreaterThan(0);
    expect(snap.heightM).toBeLessThanOrEqual(0.15);
    // An induced current is circulating, and the coupling has decayed with it.
    expect(Math.abs(snap.ringCurrentA)).toBeGreaterThan(1);
    expect(snap.couplingK).toBeGreaterThan(0);
    expect(snap.couplingK).toBeLessThan(0.65);
  });

  test('drop-tube JS plant falls at its algebraic terminal velocity', async ({ page }) => {
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);

    await page.evaluate(() => {
      window.segOperator.start();
      window.setMode('drop-tube');
    });

    // Released, inside the tube, past the entry transient (τ = m/k ≈ 18 ms, so
    // gone within a few cm) and clear of the exit taper. The plant clamps a
    // frame to 50 ms, so on a slow SwiftShader host the hold + fall to 10 cm
    // can take ~30 frames — give it the same 90 s the other slow waits get.
    await waitForEval(page,
      () => {
        const phys = window.multiVisualizer?.devices?.['drop-tube']?.physics;
        return !!phys && phys.dropTubeStage === 1 && phys.dropTubeDepthM > 0.1 && phys.dropTubeDepthM < 0.55;
      },
      { timeout: 90_000 }
    );

    const snap = await page.evaluate(() => {
      const phys = window.multiVisualizer.devices['drop-tube'].physics;
      const hub = window.telemetryHub?.getSnapshot?.()?.devices?.['drop-tube'];
      return {
        v: phys.dropTubeVMps,
        vt: phys.dropTubeTerminalVMps,
        dragN: phys.dropTubeDragN,
        eddyA: phys.dropTubeEddyIA,
        depthM: phys.dropTubeDepthM,
        hubV: hub?.dropTubeVMps
      };
    });

    // The bench's whole claim: mid-tube the magnet sits at v_t = m·g/k.
    expect(snap.vt).toBeGreaterThan(0.05);
    expect(snap.vt).toBeLessThan(0.5);
    expect(Math.abs(snap.v - snap.vt) / snap.vt).toBeLessThan(0.01);
    // The drag is doing it, carried by a circulating eddy current.
    expect(snap.dragN).toBeGreaterThan(0);
    expect(snap.eddyA).toBeGreaterThan(1);
    expect(Number.isFinite(snap.hubV)).toBe(true);
    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });

  test('lorentz-sled B slider changes the field and the force', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    await page.evaluate(() => {
      window.segOperator.start();
      window.setMode('lorentz-sled');
    });

    await waitForEval(page,
      () => (window.multiVisualizer?.devices?.['lorentz-sled']?.physics?.lorentzForceN ?? 0) > 0,
      { timeout: 30_000 }
    );

    const strong = await page.evaluate(() =>
      window.multiVisualizer.devices['lorentz-sled'].physics.lorentzFieldT);

    await page.evaluate(() => window.setLorentzFieldT(0.2));
    const weak = await page.evaluate(() =>
      window.multiVisualizer.devices['lorentz-sled'].physics.lorentzFieldT);

    expect(strong).toBeGreaterThan(weak);
    expect(weak).toBeCloseTo(0.2, 5);

    // Clamped to the bench maximum, never negative.
    await page.evaluate(() => window.setLorentzFieldT(99));
    const clamped = await page.evaluate(() =>
      window.multiVisualizer.devices['lorentz-sled'].physics.lorentzFieldT);
    expect(clamped).toBeLessThanOrEqual(1.2);
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

    // Protocol v2: the host asks with V2 and the mock answers like a v2 board.
    await waitForEval(page,
      () => window.telemetryHub?.getSnapshot?.()?.hardwareTwin?.firmwareProtocol === 2,
      { timeout: 10_000 }
    );
    await expect(page.locator('#hwFirmware')).toHaveText('fw v2 · mock · 8 coils');
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

  test('hardware panel DOM follows the bridge: status text, sensors, buttons', async ({ page }) => {
    const errors = trackPageErrors(page);
    await gotoWebGL2(page, 'mockHardware=1');

    // LabSession owns the bridge; the panel must hear about the auto-connect
    // through bridge.on('status') — it used to sit on "Disconnected" forever.
    await waitForEval(page,
      () => document.getElementById('hwStatusText')?.textContent === 'Mock stream',
      { timeout: 15_000 }
    );
    await waitForEval(page,
      () => /^-?\d/.test(document.getElementById('hwPhase')?.textContent ?? ''),
      { timeout: 10_000 }
    );

    // Real DOM clicks on the panel's own buttons.
    await page.evaluate(() => document.getElementById('hwDisconnectBtn').click());
    await waitForEval(page,
      () => document.getElementById('hwStatusText')?.textContent === 'Disconnected'
        && document.getElementById('hwDisconnectBtn')?.disabled === true,
      { timeout: 10_000 }
    );

    await page.evaluate(() => document.getElementById('hwMockBtn').click());
    await waitForEval(page,
      () => document.getElementById('hwStatusText')?.textContent === 'Mock stream'
        && document.getElementById('hwDisconnectBtn')?.disabled === false,
      { timeout: 10_000 }
    );

    // Twin mode set on the bridge reaches the <select> (twinMode event).
    await page.evaluate(() => window.multiVisualizer.hardwareBridge.setTwinMode('closed'));
    await waitForEval(page,
      () => document.getElementById('hwTwinMode')?.value === 'closed',
      { timeout: 5_000 }
    );

    // Re-attaching is idempotent: one subscriber set, one panel, one click handler.
    const after = await page.evaluate(() => {
      const b = window.multiVisualizer.hardwareBridge;
      window.hardwarePanel.attach(window.multiVisualizer);
      window.hardwarePanel.attach(window.multiVisualizer);
      return {
        panels: document.querySelectorAll('#hardware-panel').length,
        statusListeners: b._listeners.status.size
      };
    });
    expect(after.panels).toBe(1);
    expect(after.statusListeners).toBe(1);
    expect(errors.pageErrors).toEqual([]);
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

// Optional cross-device B bus (ADR-0011) — off by default, and honest about
// being a simulated estimate when it is on.
test.describe('Lab field coupling', () => {

  test('default boot leaves Hall / Lorentz B local (isolated classroom)', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    await page.evaluate(() => {
      window.segOperator?.start?.();
      window.setMode('hall');
    });

    await waitForEval(page,
      () => {
        const d = window.multiVisualizer?.devices ?? {};
        const ph = d.hall?.physicsState ?? d.hall?.physics;
        return (ph?.hallFieldT ?? 0) > 0;
      },
      { timeout: 15_000 }
    );

    const snap = await page.evaluate(() => {
      const v = window.multiVisualizer;
      const d = v?.devices ?? {};
      const ph = (id) => d[id]?.physicsState ?? d[id]?.physics ?? null;
      return {
        coupling: v?.fieldNetwork?.getSnapshot?.()?.couplingEnabled,
        hallCoupled: ph('hall')?.hallFieldCoupledT ?? null,
        sledB: ph('lorentz-sled')?.lorentzFieldT,
        sledLocal: ph('lorentz-sled')?.lorentzFieldLocalT,
        discMode: document.getElementById('fieldCouplingDisclaimer')?.dataset.mode,
        hallSource: document.getElementById('hallFieldSource')?.textContent ?? ''
      };
    });

    expect(snap.coupling).toBe(false);
    // Nothing coupling the bench: the plant is on its own drive-derived rule.
    expect(snap.hallCoupled).toBe(null);
    expect(snap.sledB).toBeCloseTo(snap.sledLocal, 5);
    expect(snap.discMode).toBe('local');
    expect(snap.hallSource).toMatch(/local/i);
  });

  test('fieldCoupling=1 tracks source estimates within the destination clamp', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'fieldCoupling=1');

    await page.evaluate(() => {
      window.segOperator?.start?.();
      window.setMode('hall');
    });

    await waitForEval(page,
      () => {
        const links = window.multiVisualizer?.fieldNetwork?.getSnapshot?.()?.links ?? {};
        return links['halbach-viz->hall']?.active === true
          && links['mhd->lorentz-sled']?.active === true;
      },
      { timeout: 15_000 }
    );

    const snap = await page.evaluate(() => {
      const v = window.multiVisualizer;
      const d = v?.devices ?? {};
      const ph = (id) => d[id]?.physicsState ?? d[id]?.physics ?? null;
      const links = v?.fieldNetwork?.getSnapshot?.()?.links ?? {};
      return {
        links,
        hallB: ph('hall')?.hallFieldT,
        hallCoupled: ph('hall')?.hallFieldCoupledT,
        halbachPeak: ph('halbach-viz')?.halbachPeakBT,
        sledB: ph('lorentz-sled')?.lorentzFieldT,
        sledLocal: ph('lorentz-sled')?.lorentzFieldLocalT,
        mhdB: ph('mhd')?.mhdBFieldT,
        hub: window.telemetryHub.getSnapshot().fieldNetwork,
        disc: document.getElementById('fieldCouplingDisclaimer')?.textContent ?? '',
        discMode: document.getElementById('fieldCouplingDisclaimer')?.dataset.mode,
        hallSource: document.getElementById('hallFieldSource')?.textContent ?? '',
        sledSource: document.getElementById('lorentzFieldSource')?.textContent ?? ''
      };
    });

    const hallLink = snap.links['halbach-viz->hall'];
    const sledLink = snap.links['mhd->lorentz-sled'];

    // Hall B is the Halbach peak, clamped to the bench's own catalog maximum.
    expect(hallLink.sourceT).toBeCloseTo(snap.halbachPeak, 5);
    expect(snap.hallCoupled).toBeCloseTo(hallLink.appliedT, 5);
    expect(snap.hallB).toBeGreaterThan(0);
    expect(snap.hallB).toBeLessThanOrEqual(0.65 + 1e-6);
    expect(hallLink.appliedT).toBeCloseTo(Math.min(snap.halbachPeak, 0.65), 5);

    // Lorentz B tracks the MHD channel field, and the local slider setpoint is
    // parked rather than overwritten.
    expect(sledLink.sourceT).toBeCloseTo(snap.mhdB, 5);
    expect(snap.sledB).toBeCloseTo(Math.min(snap.mhdB, 1.2), 5);
    expect(snap.sledLocal).toBeGreaterThan(0);
    expect(snap.sledLocal).not.toBeCloseTo(snap.sledB, 3);

    // Hub carries the same bus the UI is showing.
    expect(snap.hub?.couplingEnabled).toBe(true);
    expect(snap.hub?.links?.['halbach-viz->hall']?.appliedT).toBeCloseTo(hallLink.appliedT, 5);

    expect(snap.discMode).toBe('coupled');
    expect(snap.disc).toMatch(/not Maxwell/i);
    expect(snap.disc).toMatch(/not metrology/i);
    expect(snap.hallSource).toMatch(/halbach-viz/);
    expect(snap.hallSource).toMatch(/simulated, not metrology/i);
    expect(snap.sledSource).toMatch(/mhd/);
  });

  test('field coupling can be toggled back off, restoring the local bench B', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'fieldCoupling=1');

    await page.evaluate(() => {
      window.segOperator?.start?.();
      window.setMode('lorentz-sled');
    });
    await waitForEval(page,
      () => window.multiVisualizer?.fieldNetwork?.getLinkForDestination?.('lorentz-sled')?.active === true,
      { timeout: 15_000 }
    );

    const local = await page.evaluate(() => {
      const d = window.multiVisualizer?.devices ?? {};
      return (d['lorentz-sled']?.physicsState ?? d['lorentz-sled']?.physics)?.lorentzFieldLocalT;
    });

    await page.evaluate(() => window.setFieldCoupling(false));
    await waitForEval(page,
      () => window.multiVisualizer?.fieldNetwork?.getLinkForDestination?.('lorentz-sled')?.active === false,
      { timeout: 10_000 }
    );

    const after = await page.evaluate(() => {
      const d = window.multiVisualizer?.devices ?? {};
      const ph = d['lorentz-sled']?.physicsState ?? d['lorentz-sled']?.physics;
      const slider = document.getElementById('lorentzFieldSlider');
      return {
        B: ph?.lorentzFieldT,
        sliderDisabled: slider?.disabled,
        discMode: document.getElementById('fieldCouplingDisclaimer')?.dataset.mode
      };
    });

    expect(after.B).toBeCloseTo(local, 5);
    expect(after.sliderDisabled).toBe(false);
    expect(after.discMode).toBe('local');
  });

});

// Optional Kelvin seed from the VdG sphere (ADR-0013) — its own switch, off by
// default, never implied by the field or energy flags.
test.describe('Lab charge coupling', () => {

  const kelvinSnap = () => {
    const v = window.multiVisualizer;
    const d = v?.devices ?? {};
    const ph = (id) => d[id]?.physicsState ?? d[id]?.physics ?? null;
    return {
      coupling: v?.chargeNetwork?.getSnapshot?.()?.couplingEnabled,
      link: v?.chargeNetwork?.getSnapshot?.()?.links?.['vdg->kelvin'] ?? null,
      seed: ph('kelvin')?.kelvinSeedCoupledV ?? null,
      kelvinV: ph('kelvin')?.kelvinV,
      vbreak: ph('kelvin')?.kelvinVbreak,
      vdgV: ph('vdg')?.vdgVoltage,
      hub: window.telemetryHub.getSnapshot().chargeNetwork,
      disc: document.getElementById('chargeCouplingDisclaimer')?.textContent ?? '',
      discMode: document.getElementById('chargeCouplingDisclaimer')?.dataset.mode,
      source: document.getElementById('chargeCouplingSource')?.textContent ?? ''
    };
  };

  for (const query of ['', 'chargeCoupling=0']) {
    test(`${query || 'default boot'} leaves Kelvin and the VdG isolated`, async ({ page }) => {
      trackPageErrors(page);
      await gotoWebGL2(page, query);
      await page.evaluate(() => {
        window.segOperator?.start?.();
        window.setMode('kelvin');
      });
      await waitForEval(page,
        () => {
          const d = window.multiVisualizer?.devices ?? {};
          return ((d.kelvin?.physicsState ?? d.kelvin?.physics)?.kelvinV ?? 0) > 0;
        },
        { timeout: 15_000 }
      );

      const snap = await page.evaluate(kelvinSnap);
      expect(snap.coupling).toBe(false);
      // Nothing seeding the dropper: the plant starts from its own imbalance.
      expect(snap.seed).toBe(null);
      expect(snap.link?.active ?? false).toBe(false);
      expect(snap.link?.appliedV ?? 0).toBe(0);
      expect(snap.discMode).toBe('local');
      expect(snap.disc).toMatch(/isolated/i);
      expect(snap.source).toMatch(/isolated/i);
    });
  }

  test('chargeCoupling=1 seeds Kelvin with the clamped V·r/d estimate, named in the UI', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'chargeCoupling=1');
    await page.evaluate(() => {
      window.segOperator?.start?.();
      window.setMode('kelvin');
    });

    // The VdG is off-focus here; the session keeps its plant charging so the
    // seed is a live number rather than the 0 it was created with.
    await waitForEval(page,
      () => {
        const link = window.multiVisualizer?.chargeNetwork?.getSnapshot?.()?.links?.['vdg->kelvin'];
        return link?.active === true && link.sourceV > 0 && link.appliedV > 0;
      },
      { timeout: 20_000 }
    );

    const snap = await page.evaluate(kelvinSnap);
    const link = snap.link;
    // r_sphere / d = 0.14 m / 1.0 m (physics/constants.json).
    expect(link.estimateV).toBeCloseTo(link.sourceV * 0.14, 3);
    expect(link.appliedV).toBeCloseTo(Math.min(link.estimateV, snap.vbreak), 3);
    expect(link.appliedV).toBeLessThanOrEqual(snap.vbreak);
    expect(snap.seed).toBeCloseTo(link.appliedV, 3);

    expect(snap.hub?.couplingEnabled).toBe(true);
    expect(snap.hub?.links?.['vdg->kelvin']?.active).toBe(true);

    expect(snap.discMode).toBe('coupled');
    expect(snap.disc).toMatch(/vdg→kelvin/);
    expect(snap.disc).toMatch(/not a Laplace solve/i);
    expect(snap.disc).toMatch(/not calibrated/i);
    expect(snap.source).toMatch(/vdg/);
    expect(snap.source).toMatch(/simulated/i);

    // Toggling off hands Kelvin back its own start.
    await page.evaluate(() => window.setChargeCoupling(false));
    await waitForEval(page,
      () => {
        const d = window.multiVisualizer?.devices ?? {};
        return (d.kelvin?.physicsState ?? d.kelvin?.physics)?.kelvinSeedCoupledV === null;
      },
      { timeout: 10_000 }
    );
    const off = await page.evaluate(kelvinSnap);
    expect(off.discMode).toBe('local');
    expect(off.link.active).toBe(false);
  });

  // One page load per case: a cold WebGL2 boot is ~90 s on the SwiftShader VMs,
  // so three loads in one test would not fit the 180 s budget.
  for (const [query, expected] of [
    ['chargeCoupling=1&fieldCoupling=1&energyCoupling=1', { charge: true, field: true, energy: true }],
    ['fieldCoupling=1&energyCoupling=1', { charge: false, field: true, energy: true }],
    ['chargeCoupling=1', { charge: true, field: false, energy: false }]
  ]) {
    test(`bus flags stay independent: ${query}`, async ({ page }) => {
      trackPageErrors(page);
      await gotoWebGL2(page, query);
      const flags = await page.evaluate(() => {
        const v = window.multiVisualizer;
        return {
          charge: !!v?.chargeNetwork?.couplingEnabled,
          field: !!v?.fieldNetwork?.couplingEnabled,
          energy: !!v?.energyNetwork?.couplingEnabled
        };
      });
      expect(flags).toEqual(expected);
    });
  }

  test('overview energy pipes reach the VdG, the Hall bench and the pulse coil', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'energyCoupling=1');
    await page.evaluate(() => window.segOperator?.start?.());
    await waitForEval(page,
      () => {
        const pipes = window.multiVisualizer?.energyNetwork?.getSnapshot?.()?.pipes ?? {};
        return 'homopolar-hall' in pipes && 'transformer-vdg' in pipes && 'seg-pulse-coil' in pipes;
      },
      { timeout: 15_000 }
    );
    const pipes = await page.evaluate(() => window.multiVisualizer.energyNetwork.getSnapshot().pipes);
    expect(pipes['homopolar-hall']).toBeGreaterThanOrEqual(0);
    expect(pipes['transformer-vdg']).toBeGreaterThanOrEqual(0);
    // pulse-coil's capacity is its derived recharge nameplate, C·V²/(4τ).
    expect(pipes['seg-pulse-coil']).toBeGreaterThanOrEqual(0);
  });
});

// Explainer tours that ship their own script (LAB_TOURS registry).
test.describe('Device explainer tours', () => {
  // The scripts are a lazy chunk (seg-tour-player.ts warms it after boot); a
  // first start can wait on it, and a starved SwiftShader runner serves the
  // dev server's modules slowly.
  test.describe.configure({ timeout: 300_000 });
  const TOUR_START = { timeout: 90_000 };
  // A #lab= link is applied during boot, so its wait covers boot + the chunk.
  const BOOT_AND_TOUR = { timeout: 180_000 };

  // Every LAB_TOURS handle on window; the "only one plays" checks read this.
  const ALL_TOUR_KEYS = [
    'segTour', 'vdgTour', 'lorentzTour', 'hallTour', 'transformerTour', 'kelvinTour',
    'jumpingRingTour', 'dropTubeTour', 'heronTour', 'pulseCoilTour', 'homopolarTour', 'halbachTour',
    'peltierTour', 'mhdTour', 'maglevTour', 'solarTour'
  ];

  for (const { mode, startFn, key, firstTitle } of [
    { mode: 'hall', startFn: 'startHallTour', key: 'hallTour', firstTitle: /strip, a current/i },
    { mode: 'transformer', startFn: 'startTransformerTour', key: 'transformerTour', firstTitle: /never touch/i },
    { mode: 'kelvin', startFn: 'startKelvinTour', key: 'kelvinTour', firstTitle: /rising volts/i },
    {
      mode: 'jumping-ring',
      startFn: 'startJumpingRingTour',
      key: 'jumpingRingTour',
      firstTitle: /Lenz's law you can watch/i
    },
    {
      mode: 'drop-tube',
      startFn: 'startDropTubeTour',
      key: 'dropTubeTour',
      firstTitle: /will not fall/i
    },
    { mode: 'heron', startFn: 'startHeronTour', key: 'heronTour', firstTitle: /height in, jet out/i },
    {
      mode: 'pulse-coil',
      startFn: 'startPulseCoilTour',
      key: 'pulseCoilTour',
      firstTitle: /cannot change its current/i
    },
    {
      mode: 'homopolar',
      startFn: 'startHomopolarTour',
      key: 'homopolarTour',
      firstTitle: /no commutator/i
    },
    {
      mode: 'halbach-viz',
      startFn: 'startHalbachTour',
      key: 'halbachTour',
      firstTitle: /push the field one way/i
    },
    {
      mode: 'peltier',
      startFn: 'startPeltierTour',
      key: 'peltierTour',
      firstTitle: /heat in, a little electricity/i
    },
    { mode: 'mhd', startFn: 'startMhdTour', key: 'mhdTour', firstTitle: /flows through a field/i },
    {
      mode: 'maglev',
      startFn: 'startMaglevTour',
      key: 'maglevTour',
      firstTitle: /floating over a ring of magnets/i
    },
    {
      mode: 'solar',
      startFn: 'startSolarTour',
      key: 'solarTour',
      firstTitle: /recharge its own battery/i
    }
  ]) {
    test(`${mode} tour plays via window.${startFn}() and focuses its device`, async ({ page }) => {
      const { pageErrors } = trackPageErrors(page);
      await gotoWebGL2(page);

      // waitForEval serializes its predicate with no closure scope, so the key
      // is stashed on window for the poll to read back.
      await page.evaluate(([fn, k]) => {
        window.__tourUnderTest = k;
        window[fn]();
      }, [startFn, key]);

      await waitForEval(page,
        () => window[window.__tourUnderTest]?.playing === true,
        TOUR_START
      );

      const snap = await page.evaluate((k) => {
        const t = window[k];
        const overlay = [...document.querySelectorAll('#seg-tour-overlay')]
          .find((el) => el.style.display !== 'none');
        return {
          playing: t?.playing,
          steps: t?.steps?.length ?? 0,
          view: window.multiVisualizer?.currentView,
          title: overlay?.firstChild?.textContent ?? ''
        };
      }, key);

      expect(snap.playing).toBe(true);
      expect(snap.steps).toBeGreaterThanOrEqual(4);
      expect(snap.view).toBe(mode);
      expect(snap.title).toMatch(firstTitle);
      expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
    });
  }

  test('starting a tour stops any other one, from any entry point', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    // The explainer buttons enforce this themselves, but the window hooks and
    // #lab= replay reach a player directly. Every player shares the camera,
    // the highlight and the #lab= hash, so two live RAF loops fight over them
    // and stack two overlays.
    await page.evaluate(() => {
      window.startHallTour();
      window.startKelvinTour();
    });
    await waitForEval(page, () => window.kelvinTour?.playing === true, TOUR_START);

    const viaHooks = await page.evaluate((keys) => ({
      playing: keys
        .filter((k) => window[k]?.playing),
      visibleOverlays: [...document.querySelectorAll('#seg-tour-overlay')]
        .filter((el) => el.style.display !== 'none').length
    }), ALL_TOUR_KEYS);

    expect(viaHooks.playing).toEqual(['kelvinTour']);
    expect(viaHooks.visibleOverlays).toBe(1);

    // Same guarantee when a share link replays a different device's tour.
    await page.evaluate(() => window.transformerTour.goToStep(1));
    await waitForEval(page, () => window.transformerTour?.playing === true, { timeout: 10_000 });

    const viaLabHash = await page.evaluate((keys) => ({
      playing: keys
        .filter((k) => window[k]?.playing),
      visibleOverlays: [...document.querySelectorAll('#seg-tour-overlay')]
        .filter((el) => el.style.display !== 'none').length
    }), ALL_TOUR_KEYS);

    expect(viaLabHash.playing).toEqual(['transformerTour']);
    expect(viaLabHash.visibleOverlays).toBe(1);
  });

  test('Kelvin tour glossary is Kelvin-specific, not Van de Graaff text', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    // Step 3 (0-based) is the voltage-ceiling step, step 4 the breakdown step.
    // Both previously reused the VdG sphere/belt entries, which read as nonsense
    // on a dropper that has buckets and a gap.
    await page.evaluate(() => {
      window.startKelvinTour();
      window.kelvinTour.goToStep(3);
    });
    await waitForEval(page, () => window.kelvinTour?.stepIndex === 3, TOUR_START);

    const ceiling = await page.evaluate(() => {
      const overlay = [...document.querySelectorAll('#seg-tour-overlay')]
        .find((el) => el.style.display !== 'none');
      return overlay?.querySelector('div[style*="border-left"]')?.textContent ?? '';
    });

    expect(ceiling).toMatch(/Kelvin/i);
    expect(ceiling).not.toMatch(/sphere|belt/i);

    await page.evaluate(() => window.kelvinTour.goToStep(4));
    await waitForEval(page, () => window.kelvinTour?.stepIndex === 4, TOUR_START);

    const breakdown = await page.evaluate(() => {
      const overlay = [...document.querySelectorAll('#seg-tour-overlay')]
        .find((el) => el.style.display !== 'none');
      return overlay?.querySelector('div[style*="border-left"]')?.textContent ?? '';
    });

    expect(breakdown).toMatch(/bucket/i);
    expect(breakdown).not.toMatch(/sphere|belt/i);
  });

  test('#lab= share link reopens a device tour on its step', async ({ page }) => {
    trackPageErrors(page);
    // Steps auto-advance every ~6 s, which is shorter than a SwiftShader boot,
    // so the first poll could already see a later step. Reduced motion disables
    // auto-advance (seg-tour-player `_loop`), which pins the restored step.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // Navigated directly (not via gotoWebGL2 + a hash append): a hash-only
    // change would not reload, and the lab hash is applied at boot.
    await page.goto('/?renderer=webgl2#lab=v1;mode=hall;tour=1;step=2', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });

    await waitForEval(page,
      () => window.hallTour?.playing === true && window.hallTour?.stepIndex === 2,
      BOOT_AND_TOUR
    );

    const snap = await page.evaluate(() => ({
      playing: window.hallTour?.playing,
      step: window.hallTour?.stepIndex,
      view: window.multiVisualizer?.currentView
    }));
    expect(snap.playing).toBe(true);
    expect(snap.step).toBe(2);
    expect(snap.view).toBe('hall');
  });

  for (const { mode, key } of [
    { mode: 'heron', key: 'heronTour' },
    { mode: 'pulse-coil', key: 'pulseCoilTour' },
    { mode: 'homopolar', key: 'homopolarTour' },
    { mode: 'halbach-viz', key: 'halbachTour' }
  ]) {
    test(`#lab= share link reopens the ${mode} tour on its step`, async ({ page }) => {
      trackPageErrors(page);
      // Reduced motion stops the tour auto-advancing, so a slow frame cannot
      // carry it past step 2 and the resume step is checked exactly.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/?renderer=webgl2#lab=v1;mode=${mode};tour=1;step=2`, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000
      });

      await page.evaluate((k) => { window.__tourUnderTest = k; }, key);
      await waitForEval(page,
        () => window[window.__tourUnderTest]?.playing === true
          && window[window.__tourUnderTest]?.stepIndex === 2,
        BOOT_AND_TOUR
      );

      const snap = await page.evaluate((k) => ({
        step: window[k]?.stepIndex,
        view: window.multiVisualizer?.currentView,
        hash: location.hash
      }), key);
      expect(snap.step).toBe(2);
      expect(snap.view).toBe(mode);
      // The tour writes its own state back, so the link stays shareable.
      expect(snap.hash).toContain(`mode=${mode}`);
      expect(snap.hash).toContain('tour=1');
    });
  }

  test('every registry tour has a generated button that starts it', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    const ids = await page.evaluate(() =>
      [...document.querySelectorAll('#explainerTourRow button')].map((b) => b.id));
    expect(ids).toContain('explainerTourBtn');
    expect(ids).toContain('explainerHeronTourBtn');
    expect(ids).toContain('explainerSolarTourBtn');
    expect(ids).toContain('explainerShareBtn');

    await page.evaluate(() => document.getElementById('explainerPulseCoilTourBtn').click());
    await waitForEval(page, () => window.pulseCoilTour?.playing === true, TOUR_START);
    const view = await page.evaluate(() => window.multiVisualizer?.currentView);
    expect(view).toBe('pulse-coil');
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

test.describe('Catalog telemetry on the hub (plugin devices)', () => {

  // vdg / hall / lorentz-sled / jumping-ring publish DeviceTelemetrySnap fields named by
  // physics/devices.json telemetryKeys — no Partial<> casts in the panel.
  for (const device of [
    { id: 'vdg', keys: ['vdgVoltage', 'vdgBeltMps', 'vdgChargeC', 'vdgSparkHz'], positive: 'vdgVoltage' },
    { id: 'hall', keys: ['hallVoltage', 'hallCurrent', 'hallFieldT', 'hallCoeff'], positive: 'hallCurrent' },
    {
      id: 'lorentz-sled',
      keys: ['lorentzSledVms', 'lorentzCurrentA', 'lorentzFieldT', 'lorentzForceN', 'lorentzPositionM'],
      positive: 'lorentzCurrentA'
    },
    {
      id: 'jumping-ring',
      keys: ['ringHeightM', 'ringCurrentA', 'ringPrimaryIA', 'ringForceN', 'ringCouplingK'],
      // k(h) is the only key that is positive at every phase of the mains
      // cycle; the two currents and the force they make all change sign 120
      // times a second.
      positive: 'ringCouplingK'
    },
    {
      id: 'drop-tube',
      keys: ['dropTubeVMps', 'dropTubeTerminalVMps', 'dropTubeDragN', 'dropTubeEddyIA', 'dropTubeDepthM'],
      // v_t is positive from the first step (a copper tube always has one);
      // the speed is 0 while the clamp holds and on the catch pad.
      positive: 'dropTubeTerminalVMps'
    }
  ]) {
    test(`setMode('${device.id}') publishes finite catalog keys on the hub`, async ({ page }) => {
      trackPageErrors(page);
      await gotoWebGL2(page);

      await page.evaluate((id) => {
        window.segOperator.start();
        window.setMode(id);
      }, device.id);

      // waitForEval serializes the predicate with no arguments, so bake the ids in.
      await waitForEval(page, new Function(
        `const snap = window.telemetryHub?.getSnapshot?.()?.devices?.[${JSON.stringify(device.id)}];`
        + `return !!snap && Number.isFinite(snap[${JSON.stringify(device.positive)}])`
        + ` && snap[${JSON.stringify(device.positive)}] > 0;`
      ), { timeout: 30_000 });

      const result = await page.evaluate(({ id, keys }) => {
        const snap = window.telemetryHub.getSnapshot();
        const dev = snap.devices?.[id] || {};
        return {
          view: snap.view,
          id: dev.id,
          values: Object.fromEntries(keys.map((k) => [k, dev[k]])),
          footer: document.getElementById('batteryFooter')?.textContent ?? '',
          readoutHidden: document.getElementById('device-readout')?.hidden,
          readoutCells: document.querySelectorAll('#device-readout-grid .seg-led-cell').length
        };
      }, device);

      expect(result.id).toBe(device.id);
      for (const key of device.keys) {
        expect(Number.isFinite(result.values[key]), `${key} = ${result.values[key]}`).toBe(true);
      }
      expect(result.values[device.positive]).toBeGreaterThan(0);

      // Focus chrome shows this device's own keys, not SEG RPM.
      expect(result.readoutHidden).toBe(false);
      expect(result.readoutCells).toBe(device.keys.length);
      expect(result.footer).not.toBe('—');
    });
  }

  test('recorded CSV carries plugin columns and replay restores them', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);

    const exported = await page.evaluate(async () => {
      const { rowFromSnapshot, rowsToCsv, csvToRows, TELEMETRY_CSV_COLUMNS, TELEMETRY_CSV_VERSION } =
        await import('/telemetry/telemetry-schema.ts');

      window.segOperator.start();
      window.setMode('hall');
      for (let i = 0; i < 60; i++) {
        window.telemetryHub.publishFrame({ dt: 1 / 60, view: 'hall' });
      }

      const snap = window.telemetryHub.getSnapshot();
      const rows = [rowFromSnapshot(snap, 0), rowFromSnapshot(snap, 0.1)];
      const csv = rowsToCsv(rows);
      const parsed = csvToRows(csv);
      return {
        version: TELEMETRY_CSV_VERSION,
        hasColumn: TELEMETRY_CSV_COLUMNS.includes('hall_voltage'),
        header: csv.split('\n')[0],
        liveHallVoltage: snap.devices?.hall?.hallVoltage ?? null,
        parsedHallVoltage: parsed[0]?.hall_voltage ?? null,
        parsedSledSpeed: parsed[0]?.lorentz_sled_vms ?? null
      };
    });

    expect(exported.version).toBeGreaterThanOrEqual(2);
    expect(exported.hasColumn).toBe(true);
    expect(exported.header).toContain('hall_voltage');
    expect(exported.header).toContain('lorentz_sled_vms');
    expect(Number.isFinite(exported.parsedHallVoltage)).toBe(true);
    expect(exported.parsedHallVoltage).toBeCloseTo(exported.liveHallVoltage, 6);
    expect(Number.isFinite(exported.parsedSledSpeed)).toBe(true);

    // Replay a two-sample recording and check the plugin snap comes back.
    const restored = await page.evaluate(async () => {
      const { buildReplayFile } = await import('/telemetry/replay-format.ts');
      const base = {
        frame_id: 1, view: 'hall', mode: 'hall', status: 'operational',
        rpm_inner: 0, seg_omega: 0, corona: 0, voltage_v: 0, current_a: 0, power_w: 0,
        field_sim_t: 0, energy_density_j_m3: 0, drive: 0.5, excitation_pct: 50,
        temperature_c: 25, efficiency_pct: 0, particle_flux: 0, load_ohm: 100,
        hw_connected: 0, hw_connection_state: 'disconnected',
        phase_error_deg: '', rpm_error: '', voltage_error_v: '', current_error_a: '',
        energy_residual_w: '', energy_coupled: 0,
        hall_voltage: 0.0042, hall_current: 3.5, hall_field_t: 0.8, hall_coeff: 1.2e-10
      };
      window.replayPlayer.attach(buildReplayFile({
        samples: [{ ...base, time_s: 0 }, { ...base, time_s: 1 }]
      }));
      window.replayPlayer.seek(1);
      const dev = window.telemetryHub.getSnapshot().devices?.hall;
      const out = {
        hallVoltage: dev?.hallVoltage ?? null,
        hallCurrent: dev?.hallCurrent ?? null,
        hallFieldT: dev?.hallFieldT ?? null
      };
      window.replayPlayer.exit();
      return out;
    });

    expect(restored.hallVoltage).toBeCloseTo(0.0042, 6);
    expect(restored.hallCurrent).toBeCloseTo(3.5, 6);
    expect(restored.hallFieldT).toBeCloseTo(0.8, 6);
  });
});

test.describe('Lab sonification (?audio=1)', () => {

  test('default boot constructs no audio and adds no control', async ({ page }) => {
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => !!window.labAudio, { timeout: 30_000 });

    const state = await page.evaluate(() => ({
      enabled: window.labAudio.enabled,
      started: window.labAudio.started,
      muted: window.labAudio.muted,
      badge: !!document.getElementById('lab-audio-badge')
    }));
    // The acceptance criterion is "default boot is silent" — not merely quiet.
    expect(state.enabled).toBe(false);
    expect(state.started).toBe(false);
    expect(state.muted).toBe(true);
    expect(state.badge).toBe(false);
    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });

  test('?audio=1 arms, starts on a gesture, and the badge mutes it', async ({ page }) => {
    // Boot plus three gesture round-trips: on SwiftShader each one can stall
    // the main thread for 10–25 s, which overruns the default 180 s budget.
    test.slow();
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page, 'audio=1');
    await waitForEval(page, () => !!window.labAudio, { timeout: 30_000 });

    // Armed but silent: browsers require a user gesture before an AudioContext,
    // and the badge says so rather than looking broken.
    const armed = await page.evaluate(() => ({
      enabled: window.labAudio.enabled,
      started: window.labAudio.started,
      muted: window.labAudio.muted,
      badge: document.getElementById('lab-audio-badge')?.dataset.state ?? null
    }));
    expect(armed.enabled).toBe(true);
    expect(armed.started).toBe(false);
    expect(armed.muted).toBe(true);
    expect(armed.badge).toBe('waiting');

    // Trusted input, but not page.click(): an element click waits for the main
    // thread to acknowledge it, and a SwiftShader frame can stall long enough to
    // time out after the handler has already run (see helpers.js). page.mouse
    // dispatches a real browser event — so this exercises the production user-
    // activation contract that Web Audio startup depends on — without the
    // actionability wait.
    const tapBadge = async () => {
      const box = await page.evaluate(() => {
        const r = document.getElementById('lab-audio-badge').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      await page.mouse.click(box.x, box.y);
    };
    await tapBadge();
    await waitForEval(page, () => window.labAudio.started === true, { timeout: 30_000 });
    await waitForEval(page, () => window.labAudio.muted === false, { timeout: 30_000 });
    await waitForEval(page,
      () => document.getElementById('lab-audio-badge')?.dataset.state === 'on',
      { timeout: 30_000 });

    // A spark cue must not throw with a live graph.
    await page.evaluate(() => window.labAudio.click({
      kind: 'kelvin', frequency: 2600, gain: 0.5, durationS: 0.05
    }));

    // Mute-able, which is the other half of the acceptance criterion.
    await tapBadge();
    await waitForEval(page, () => window.labAudio.muted === true, { timeout: 30_000 });
    await waitForEval(page,
      () => document.getElementById('lab-audio-badge')?.dataset.state === 'muted',
      { timeout: 30_000 });

    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });
});

test.describe('FDTD micro-grid heatmap (WebGL2 stand-in)', () => {

  test('hidden outside pulse-coil focus, visible in it, and clear of the tachometer', async ({ page }) => {
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => !!window.fdtdHeatmapOverlay, { timeout: 30_000 });

    // Overview: armed but inert — no stepping, nothing on screen.
    const atBoot = await page.evaluate(() => ({
      enabled: window.fdtdHeatmapOverlay.enabled,
      active: window.fdtdHeatmapOverlay.active,
      visible: !!document.querySelector('#fdtd-heatmap-overlay:not([hidden])')
    }));
    expect(atBoot.enabled).toBe(true);
    expect(atBoot.active).toBe(false);
    expect(atBoot.visible).toBe(false);

    await page.evaluate(() => window.setMode?.('pulse-coil'));
    await waitForEval(page, () => window.fdtdHeatmapOverlay.active === true, { timeout: 30_000 });

    const focused = await page.evaluate(() => {
      const el = document.getElementById('fdtd-heatmap-overlay');
      const tach = document.getElementById('tachometer');
      const a = el?.getBoundingClientRect();
      const t = tach?.getBoundingClientRect();
      const overlaps = a && t
        && a.left < t.right && a.right > t.left && a.top < t.bottom && a.bottom > t.top;
      return {
        hidden: el?.hasAttribute('hidden') ?? null,
        width: Math.round(a?.width ?? 0),
        height: Math.round(a?.height ?? 0),
        overlapsTachometer: !!overlaps,
        // A readout must never swallow a camera drag.
        pointerEvents: el ? getComputedStyle(el).pointerEvents : null
      };
    });
    expect(focused.hidden).toBe(false);
    expect(focused.width).toBeGreaterThan(100);
    expect(focused.height).toBeGreaterThan(100);
    expect(focused.overlapsTachometer).toBe(false);
    expect(focused.pointerEvents).toBe('none');

    // The grid must actually be evolving, not a blank canvas. Force the drive —
    // the plant may be idle here — then step and read the public hook.
    const evolves = await page.evaluate(() => {
      const o = window.fdtdHeatmapOverlay;
      o.driveTarget = 1.2;
      for (let i = 0; i < 90; i++) o.step();
      return o.stats();
    });
    expect(evolves.finite).toBe(true);
    expect(evolves.peakEz).toBeGreaterThan(0);
    expect(evolves.hasMaterials).toBe(true);
    expect(evolves.steps).toBeGreaterThan(0);

    // Leaving focus stops the stepping and hides it again.
    await page.evaluate(() => window.setMode?.('overview'));
    await waitForEval(page, () => window.fdtdHeatmapOverlay.active === false, { timeout: 30_000 });
    const left = await page.evaluate(
      () => document.getElementById('fdtd-heatmap-overlay')?.hasAttribute('hidden') ?? null
    );
    expect(left).toBe(true);

    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });

  test('?fdtd=0 keeps the readout off entirely', async ({ page }) => {
    await gotoWebGL2(page, 'fdtd=0');
    await waitForEval(page, () => !!window.fdtdHeatmapOverlay, { timeout: 30_000 });
    await page.evaluate(() => window.setMode?.('pulse-coil'));
    const state = await page.evaluate(() => ({
      enabled: window.fdtdHeatmapOverlay.enabled,
      active: window.fdtdHeatmapOverlay.active,
      mounted: !!document.getElementById('fdtd-heatmap-overlay')
    }));
    expect(state.enabled).toBe(false);
    expect(state.active).toBe(false);
    expect(state.mounted).toBe(false);
  });
});

// Showroom / Lab / Twin preset bundle (src/lab-mode.ts) — one switch over the
// flags ADR-0005 scattered. The bundle is the default; an explicit flag wins.
test.describe('Lab mode', () => {
  test('no labMode anywhere → no bundle applied, no button pressed', async ({ page }) => {
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => !!document.getElementById('labmode-lab'), { timeout: 30_000 });
    const s = await page.evaluate(() => ({
      mode: window.getLabMode?.() ?? null,
      body: document.body.dataset.labMode ?? null,
      pressed: [...document.querySelectorAll('[data-lab-mode-btn]')]
        .filter((b) => b.getAttribute('aria-pressed') === 'true').length,
      buttons: [...document.querySelectorAll('[data-lab-mode-btn]')].map((b) => b.dataset.labModeBtn)
    }));
    expect(s.mode).toBeNull();
    expect(s.body).toBeNull();
    expect(s.pressed).toBe(0);
    expect(s.buttons).toEqual(['showroom', 'lab', 'twin']);
    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });

  test('?labMode=showroom strips teaching chrome, folds the twin, turns buses off', async ({ page }) => {
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page, 'labMode=showroom');
    await waitForEval(page, () => window.getLabMode?.() === 'showroom', { timeout: 60_000 });
    const s = await page.evaluate(() => ({
      pressed: document.getElementById('labmode-showroom')?.getAttribute('aria-pressed'),
      explainer: getComputedStyle(document.getElementById('seg-explainer-section')).display,
      fieldSec: getComputedStyle(document.getElementById('field-coupling-section')).display,
      chargeSec: getComputedStyle(document.getElementById('charge-coupling-section')).display,
      hwCollapsed: document.getElementById('hardware-panel')?.dataset.collapsed ?? null,
      look: window.multiVisualizer?.lightingLook,
      fieldOn: window.multiVisualizer?.fieldNetwork?.couplingEnabled,
      stored: localStorage.getItem('seg-lab-mode')
    }));
    expect(s.pressed).toBe('true');
    expect(s.explainer).toBe('none');
    expect(s.fieldSec).toBe('none');
    expect(s.chargeSec).toBe('none');
    expect(s.hwCollapsed).toBe('true');
    expect(s.look).toBe('studio');
    expect(s.fieldOn).toBe(false);
    // `?labMode=` at boot is a URL choice, not a click: nothing is remembered yet.
    expect(s.stored).toBeNull();
    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });

  test('?labMode=lab shows the explainer and coupling controls, and the lab look', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'labMode=lab');
    await waitForEval(page, () => window.getLabMode?.() === 'lab', { timeout: 60_000 });
    const s = await page.evaluate(() => ({
      explainer: getComputedStyle(document.getElementById('seg-explainer-section')).display,
      fieldSec: getComputedStyle(document.getElementById('field-coupling-section')).display,
      chargeSec: getComputedStyle(document.getElementById('charge-coupling-section')).display,
      hwCollapsed: document.getElementById('hardware-panel')?.dataset.collapsed ?? null,
      look: window.multiVisualizer?.lightingLook,
      fieldOn: window.multiVisualizer?.fieldNetwork?.couplingEnabled
    }));
    expect(s.explainer).not.toBe('none');
    expect(s.fieldSec).not.toBe('none');
    expect(s.chargeSec).not.toBe('none');
    expect(s.hwCollapsed).toBe('false');
    expect(s.look).toBe('lab');
    // Controls visible, buses still default-off until the user enables one.
    expect(s.fieldOn).toBe(false);
  });

  test('an explicit flag beats the bundle (look, class, a bus)', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'labMode=showroom&look=drama&class=1&fieldCoupling=1');
    await waitForEval(page, () => window.getLabMode?.() === 'showroom', { timeout: 60_000 });
    const s = await page.evaluate(() => ({
      look: window.multiVisualizer?.lightingLook,
      classroom: window.explainerState?.classroomMode,
      explainer: getComputedStyle(document.getElementById('seg-explainer-section')).display,
      fieldOn: window.multiVisualizer?.fieldNetwork?.couplingEnabled,
      fieldSec: getComputedStyle(document.getElementById('field-coupling-section')).display,
      chargeOn: window.multiVisualizer?.chargeNetwork?.couplingEnabled
    }));
    expect(s.look).toBe('drama');
    expect(s.classroom).toBe(true);
    expect(s.explainer).not.toBe('none');
    expect(s.fieldOn).toBe(true);
    // A live bus must keep its switch on screen.
    expect(s.fieldSec).not.toBe('none');
    // Unmentioned buses are still the bundle's to turn off.
    expect(s.chargeOn).toBeFalsy();
  });

  test('header buttons apply the whole bundle, remember it, and write ?labMode=', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'labMode=lab&look=drama');
    await waitForEval(page, () => window.getLabMode?.() === 'lab', { timeout: 60_000 });
    // Boot honoured the explicit look…
    expect(await page.evaluate(() => window.multiVisualizer?.lightingLook)).toBe('drama');

    // …but a click is an explicit choice of the whole bundle.
    await page.evaluate(() => document.getElementById('labmode-showroom').click());
    await waitForEval(page, () => window.getLabMode?.() === 'showroom', { timeout: 30_000 });
    const s = await page.evaluate(() => ({
      look: window.multiVisualizer?.lightingLook,
      stored: localStorage.getItem('seg-lab-mode'),
      param: new URL(location.href).searchParams.get('labMode'),
      pressed: ['showroom', 'lab', 'twin'].filter(
        (m) => document.getElementById(`labmode-${m}`).getAttribute('aria-pressed') === 'true'),
      explainer: getComputedStyle(document.getElementById('seg-explainer-section')).display
    }));
    expect(s.look).toBe('studio');
    expect(s.stored).toBe('showroom');
    expect(s.param).toBe('showroom');
    expect(s.pressed).toEqual(['showroom']);
    expect(s.explainer).toBe('none');

    // Back to Lab restores the chrome showroom hid.
    await page.evaluate(() => document.getElementById('labmode-lab').click());
    await waitForEval(page, () => window.getLabMode?.() === 'lab', { timeout: 30_000 });
    const back = await page.evaluate(() => ({
      explainer: getComputedStyle(document.getElementById('seg-explainer-section')).display,
      fieldSec: getComputedStyle(document.getElementById('field-coupling-section')).display,
      look: window.multiVisualizer?.lightingLook
    }));
    expect(back.explainer).not.toBe('none');
    expect(back.fieldSec).not.toBe('none');
    expect(back.look).toBe('lab');
  });

  test('the remembered mode applies on a bare reload', async ({ page }) => {
    trackPageErrors(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('seg-lab-mode', 'showroom'); } catch (_) { /* ignore */ }
    });
    await gotoWebGL2(page);
    await waitForEval(page, () => window.getLabMode?.() === 'showroom', { timeout: 60_000 });
    expect(await page.evaluate(() => document.body.dataset.labMode)).toBe('showroom');
  });

  test('showroom forces a bus off for the session without rewriting the stored preference', async ({ page }) => {
    trackPageErrors(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('seg-field-coupling', 'true'); } catch (_) { /* ignore */ }
    });
    await gotoWebGL2(page, 'labMode=showroom');
    await waitForEval(page, () => window.getLabMode?.() === 'showroom', { timeout: 60_000 });
    const s = await page.evaluate(() => ({
      on: window.multiVisualizer?.fieldNetwork?.couplingEnabled,
      stored: localStorage.getItem('seg-field-coupling')
    }));
    expect(s.on).toBe(false);
    expect(s.stored).toBe('true');
  });

  test('twin opens the residual gauges; leaving it coasts a live link without disconnecting', async ({ page }) => {
    test.setTimeout(300_000);
    trackPageErrors(page);
    await gotoWebGL2(page, 'labMode=twin&mockHardware=1');
    await waitForEval(page, () => window.getLabMode?.() === 'twin'
      && window.multiVisualizer?.hardwareBridge?.isConnected === true, { timeout: 90_000 });
    const open = await page.evaluate(() => ({
      sci: window.sciUI?.isVisible,
      hwCollapsed: document.getElementById('hardware-panel')?.dataset.collapsed ?? null
    }));
    expect(open.sci).toBe(true);
    expect(open.hwCollapsed).toBe('false');

    await page.evaluate(() => window.multiVisualizer.hardwareBridge.setManualCoils(0b11, 0.75));
    await page.evaluate(() => document.getElementById('labmode-lab').click());
    await waitForEval(page, () => window.getLabMode?.() === 'lab', { timeout: 30_000 });
    const left = await page.evaluate(() => {
      const b = window.multiVisualizer.hardwareBridge;
      return { connected: b.isConnected, manual: b.manualMode, duty: b.manualPwmDuty, sci: window.sciUI?.isVisible };
    });
    expect(left.connected).toBe(true);
    expect(left.manual).toBe(false);
    expect(left.duty).toBe(0);
    // The gauges Twin opened close again; a panel the user opened themselves would stay.
    expect(left.sci).toBe(false);
  });

  test('catalog mode buttons still switch bench', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'labMode=lab');
    await waitForEval(page, () => window.getLabMode?.() === 'lab' && !!document.getElementById('btn-heron'),
      { timeout: 60_000 });
    await page.evaluate(() => document.getElementById('btn-heron').click());
    await waitForEval(page, () => window.getRendererInfo()?.view === 'heron'
      && document.getElementById('btn-heron').classList.contains('active'), { timeout: 30_000 });
  });

  test('focus change is announced: mode + bench + one number, in a polite live region', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page, 'labMode=lab');
    await waitForEval(page, () => window.getLabMode?.() === 'lab', { timeout: 60_000 });
    await page.evaluate(() => window.setMode('pulse-coil'));
    await waitForEval(page,
      () => /Pulse Coil/.test(document.getElementById('focusLiveRegion')?.textContent ?? ''),
      { timeout: 30_000 });
    const s = await page.evaluate(() => {
      const el = document.getElementById('focusLiveRegion');
      return {
        role: el.getAttribute('role'),
        live: el.getAttribute('aria-live'),
        text: el.textContent,
        readoutName: document.getElementById('device-readout')?.getAttribute('aria-label') ?? null
      };
    });
    expect(s.role).toBe('status');
    expect(s.live).toBe('polite');
    expect(s.text).toMatch(/^Lab mode\. Pulse Coil/);
    expect(s.text).not.toMatch(/NaN/);
    expect(s.text).toMatch(/\d/);
    expect(s.readoutName).toMatch(/Pulse Coil/);
  });
});

// Catalog `setpoints` → generated sliders (src/setpoint-sliders.ts). The page
// carries no per-device slider markup; the panel only writes, the plant steps.
test.describe('Catalog setpoint sliders', () => {
  test('each declared setpoint gets a slider with catalog bounds, shown only for its bench', async ({ page }) => {
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => !!document.getElementById('lorentzFieldSlider'), { timeout: 60_000 });
    const dom = await page.evaluate(() => ['lorentzFieldSlider', 'halbachSegmentsSlider', 'pulseCoilChargeSlider', 'dropTubeSigmaSlider'].map((id) => {
      const el = document.getElementById(id);
      return { id, min: el?.min, max: el?.max, step: el?.step, label: el?.getAttribute('aria-label') };
    }));
    expect(dom).toEqual([
      expect.objectContaining({ id: 'lorentzFieldSlider', min: '0', max: '1.2', step: '0.05' }),
      expect.objectContaining({ id: 'halbachSegmentsSlider', min: '4', max: '24', step: '1' }),
      expect.objectContaining({ id: 'pulseCoilChargeSlider', min: '0', max: '48', step: '1' }),
      expect.objectContaining({ id: 'dropTubeSigmaSlider', min: '0', max: '60', step: '0.1' })
    ]);
    for (const d of dom) expect(d.label).toBeTruthy();

    const shown = async (mode) => {
      await page.evaluate((m) => window.setMode(m), mode);
      return page.evaluate(() => [...document.querySelectorAll('[data-setpoint-device]')]
        .filter((el) => !el.hidden).map((el) => el.dataset.setpointDevice));
    };
    expect(await shown('halbach-viz')).toEqual(['halbach-viz']);
    expect(await shown('pulse-coil')).toEqual(['pulse-coil']);
    expect(await shown('lorentz-sled')).toEqual(['lorentz-sled']);
    expect(await shown('drop-tube')).toEqual(['drop-tube']);
    expect(await shown('overview')).toEqual([]);
    expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  });

  test('Lorentz slider still writes setLorentzFieldT (local B), clamped by the plant', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => !!document.getElementById('lorentzFieldSlider')
      && !!window.multiVisualizer?.devices?.['lorentz-sled'], { timeout: 60_000 });
    await page.evaluate(() => window.setMode('lorentz-sled'));
    await page.evaluate(() => {
      const s = document.getElementById('lorentzFieldSlider');
      s.value = '0.35';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const s = await page.evaluate(() => {
      const d = window.multiVisualizer.devices['lorentz-sled'];
      const ph = d.physicsState ?? d.physics;
      return { local: ph.lorentzFieldLocalT, B: ph.lorentzFieldT, label: document.getElementById('lorentzFieldValue').textContent };
    });
    expect(s.local).toBeCloseTo(0.35, 5);
    expect(s.B).toBeCloseTo(0.35, 5);
    expect(s.label).toBe('0.35 T');
  });

  test('Halbach N pins against the drive sweep, and Auto hands it back', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => !!window.multiVisualizer?.devices?.['halbach-viz'], { timeout: 60_000 });
    await page.evaluate(() => window.setMode('halbach-viz'));
    await page.evaluate(() => {
      const s = document.getElementById('halbachSegmentsSlider');
      s.value = '7';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const n = () => page.evaluate(() => {
      const d = window.multiVisualizer.devices['halbach-viz'];
      const ph = d.physicsState ?? d.physics;
      return { count: ph.halbachSegmentCount, set: ph.halbachSegmentSetpoint };
    });
    // The plant must keep honouring the pin on frames after the input event.
    await waitForEval(page, () => {
      const ph = window.multiVisualizer.devices['halbach-viz'];
      return (ph.physicsState ?? ph.physics).halbachSegmentCount === 7;
    }, { timeout: 30_000 });
    await page.waitForTimeout(500);
    expect(await n()).toEqual({ count: 7, set: 7 });

    await page.evaluate(() => document.getElementById('halbachSegmentsRelease').click());
    expect((await n()).set).toBeNull();
  });

  test('pulse-coil charge target pins the bank and is clamped to the catalog range', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => !!window.multiVisualizer?.devices?.['pulse-coil'], { timeout: 60_000 });
    await page.evaluate(() => window.setMode('pulse-coil'));
    await page.evaluate(() => {
      const s = document.getElementById('pulseCoilChargeSlider');
      s.value = '30';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const set = await page.evaluate(() => {
      const d = window.multiVisualizer.devices['pulse-coil'];
      return (d.physicsState ?? d.physics).pulseCoilChargeSetpointV;
    });
    expect(set).toBe(30);
  });

  test('drop-tube σ slider swaps the tube material, and Auto returns to copper', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => !!window.multiVisualizer?.devices?.['drop-tube']
      && !!document.getElementById('dropTubeSigmaSlider'), { timeout: 60_000 });
    await page.evaluate(() => {
      window.segOperator.start();
      window.setMode('drop-tube');
    });
    const read = () => page.evaluate(() => {
      const d = window.multiVisualizer.devices['drop-tube'];
      const ph = d.physicsState ?? d.physics;
      return { set: ph.dropTubeSigmaSetpointMSm, sigma: ph.dropTubeSigmaMSm, vt: ph.dropTubeTerminalVMps };
    });
    await waitForEval(page, () => {
      const d = window.multiVisualizer.devices['drop-tube'];
      return Number.isFinite((d.physicsState ?? d.physics).dropTubeTerminalVMps);
    }, { timeout: 30_000 });
    const copper = await read();
    expect(copper.set).toBeNull();
    expect(copper.sigma).toBeCloseTo(59.6, 5);

    // Aluminium: v_t scales as 1/σ.
    await page.evaluate(() => {
      const s = document.getElementById('dropTubeSigmaSlider');
      s.value = '37.7';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForEval(page, () => {
      const d = window.multiVisualizer.devices['drop-tube'];
      return (d.physicsState ?? d.physics).dropTubeSigmaMSm === 37.7;
    }, { timeout: 30_000 });
    const al = await read();
    expect(al.set).toBe(37.7);
    expect(al.vt / copper.vt).toBeCloseTo(59.6 / 37.7, 4);

    // Plastic: no terminal velocity, and the readout says so rather than a number.
    await page.evaluate(() => {
      const s = document.getElementById('dropTubeSigmaSlider');
      s.value = '0';
      s.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForEval(page, () => {
      const d = window.multiVisualizer.devices['drop-tube'];
      return (d.physicsState ?? d.physics).dropTubeSigmaMSm === 0;
    }, { timeout: 30_000 });
    expect(Number.isNaN((await read()).vt)).toBe(true);

    await page.evaluate(() => document.getElementById('dropTubeSigmaRelease').click());
    await waitForEval(page, () => {
      const d = window.multiVisualizer.devices['drop-tube'];
      return (d.physicsState ?? d.physics).dropTubeSigmaMSm === 59.6;
    }, { timeout: 30_000 });
    expect((await read()).set).toBeNull();
  });

  test('#lab= pcap / hseg / lfield share links pin through the same setpoints', async ({ page }) => {
    trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => !!window.multiVisualizer?.devices?.['halbach-viz']
      && !!window.multiVisualizer?.devices?.['pulse-coil'], { timeout: 60_000 });
    await page.evaluate(async () => {
      const { applyLabState, decodeLabHash } = await import('/seg-explainer/lab-url.ts');
      await applyLabState(decodeLabHash('#lab=v1;mode=halbach-viz;hseg=12'));
      await applyLabState(decodeLabHash('#lab=v1;mode=pulse-coil;pcap=0.5'));
    });
    const s = await page.evaluate(() => {
      const ph = (id) => window.multiVisualizer.devices[id].physicsState ?? window.multiVisualizer.devices[id].physics;
      return { hseg: ph('halbach-viz').halbachSegmentSetpoint, pcap: ph('pulse-coil').pulseCoilChargeSetpointV };
    });
    expect(s.hseg).toBe(12);
    expect(s.pcap).toBe(24);
  });
});

test.describe('LabConfig share links v2 (#224 §1)', () => {
  test('window.lab.loadConfig applies live fields and writes a #lab2= link that boots back', async ({ page }) => {
    // Two boots plus the lab-file / lab-url / share chunks; SwiftShader can starve module loads.
    test.setTimeout(480_000);
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => !!window.multiVisualizer?.devices?.hall && !!window.lab, { timeout: 120_000 });

    const result = await page.evaluate(() => window.lab.loadConfig({
      format: 'seg-lab', version: 1, schema: 'old-schema',
      config: { mode: 'hall', look: 'lab', fieldCoupling: true, seed: 4242, bogus: 1, renderer: 'webgpu' }
    }));
    expect(result.reloading).toBe(false);
    expect([...result.applied].sort()).toEqual(['fieldCoupling', 'look', 'mode', 'seed']);
    expect(result.ignored).toEqual(expect.arrayContaining(['bogus', 'renderer']));

    const live = await page.evaluate(() => ({
      view: window.multiVisualizer.currentView,
      look: window.multiVisualizer.lightingLook,
      field: window.multiVisualizer.fieldNetwork?.couplingEnabled,
      hash: location.hash
    }));
    expect(live.view).toBe('hall');
    expect(live.look).toBe('lab');
    expect(live.field).toBe(true);
    expect(live.hash.startsWith('#lab2=')).toBe(true);

    const url = await page.evaluate(() => window.lab.shareLink());
    expect(url).toMatch(/[?&]renderer=webgl2.*#lab2=[zj][A-Za-z0-9_-]+$/);
    expect(url.length).toBeLessThan(600);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForEval(page, () => window.currentRenderer === 'webgl2'
      && window.multiVisualizer?.currentView === 'hall', { timeout: 120_000 });
    const booted = await page.evaluate(() => ({
      look: window.multiVisualizer.lightingLook,
      lookSource: window.lab.sources().look,
      field: window.multiVisualizer.fieldNetwork?.couplingEnabled,
      seed: window.lab.config().seed,
      seedSource: window.lab.sources().seed
    }));
    expect(booted.look).toBe('lab');
    expect(booted.lookSource).toBe('hash');
    expect(booted.field).toBe(true);
    expect(booted.seed).toBe(4242);
    expect(booted.seedSource).toBe('hash');
    expect(pageErrors).toEqual([]);
  });

  test('a dropped .lab.json loads; a junk #lab2= is ignored, not fatal', async ({ page }) => {
    test.setTimeout(480_000);
    const { pageErrors } = trackPageErrors(page);
    await page.goto('/?renderer=webgl2#lab2=zNOT-A-REAL-PAYLOAD', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await waitForEval(page, () => window.currentRenderer === 'webgl2' && !!window.multiVisualizer?.devices?.transformer
      && !!window.lab, { timeout: 120_000 });

    const taken = await page.evaluate(() => {
      const file = new File([JSON.stringify({
        format: 'seg-lab', version: 1, schema: 'x', config: { mode: 'transformer', heronLayout: 'tower' }
      })], 'bench.lab.json', { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);
      return !document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    // The drop listener is there from boot, so the drop is taken at once; the
    // loader is a lazy lab-file → lab-url chain, 90 s+ in dev mode on SwiftShader.
    expect(taken).toBe(true);
    await waitForEval(page, () => window.multiVisualizer?.currentView === 'transformer'
      && window.multiVisualizer?.heronLayoutPreset === 'tower', { timeout: 300_000 });
    expect(pageErrors).toEqual([]);
  });
});

test.describe('Plant snapshots (#224 §2)', () => {
  test('restoreSnapshot of a steady operating point: telemetry is at steady state at once (no spin-up)', async ({ page }) => {
    // Boot + the lazy snapshot chunk; SwiftShader can starve module loads.
    test.setTimeout(300_000);
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page);
    await waitForEval(page, () => !!window.lab?.restoreSnapshot && !!window.multiVisualizer?.devices?.vdg
      && !!window.telemetryHub, { timeout: 120_000 });

    // A saved operating point, as a .lab.json `state` carries it (JSON). SEG
    // at full drive and excitation balances drive torque against eddy +
    // viscous drag at exactly ω = 1 (1.33/1.4 + 0.05), i.e. OPERATIONAL; a
    // fresh START would spend seconds spinning up to it. The VdG sphere comes
    // back charged too. No C++ vector: this lab runs the JS plants.
    const restored = await page.evaluate(async () => {
      const snapshot = {
        format: 'seg-plant-snapshot', version: 1, layoutHash: 0, catalogHash: '', backend: 'js',
        focus: 'seg', view: window.multiVisualizer.currentView, t: 600, seed: null, config: {},
        operator: {
          status: 'operational', isRunning: true, targetDrive: 1, magneticFieldStrength: 1, loadResistance: 100,
          totalEnergy: 0, efficiency: 90, displayRpm: 3000, displayField: 0.7,
          physics: { segOmega: 1, corona: 1, energyLevel: 1, magneticFieldStrength: 1 }
        },
        devices: { vdg: { vdgChargeC: 2e-6, vdgVoltage: 150000 } }
      };
      const ok = await window.lab.restoreSnapshot(JSON.parse(JSON.stringify(snapshot)));
      const seg = window.telemetryHub.getSnapshot().seg;
      return {
        ok,
        status: seg.status,
        segOmega: seg.segOmega,
        rpmInner: seg.rpmInner,
        simT: window.telemetryHub.getSimTimeS(),
        vdgV: window.multiVisualizer.devices.vdg.physicsState?.vdgVoltage
      };
    });
    expect(restored.ok).toBe(true);
    // Straight away — no spin-up ramp from rest.
    expect(restored.status).toBe('operational');
    expect(restored.segOmega).toBe(1);
    expect(restored.rpmInner).toBe(3000);
    expect(restored.simT).toBe(600);
    expect(restored.vdgV).toBe(150000);

    // Live stepping resumes from the restored point and stays on it.
    await waitForEval(page, () => window.telemetryHub.getSimTimeS() > 600.5, { timeout: 120_000 });
    const live = await page.evaluate(() => ({
      status: window.segOperator.status,
      segOmega: window.segOperator.physics.segOmega
    }));
    expect(live.status).toBe('operational');
    expect(Math.abs(live.segOmega - 1)).toBeLessThan(1e-3);

    // Not a snapshot: refused, nothing thrown.
    expect(await page.evaluate(() => window.lab.restoreSnapshot({ format: 'nope' }))).toBe(false);
    expect(pageErrors).toEqual([]);
  });

  test('replay "Take over" restores the keyframe at or before the cursor and runs live from it', async ({ page }) => {
    test.setTimeout(300_000);
    const { pageErrors } = trackPageErrors(page);
    await gotoWebGL2(page, 'replay=1');
    await waitForEval(page, () => typeof window.applyReplayFile === 'function' && !!window.replayPlayer
      && !!window.telemetryHub && !!window.multiVisualizer?.session, { timeout: 120_000 });

    // Samples start at time_s = 10 (keyframe `t` is on that clock). Two
    // keyframes of the same steady SEG point, told apart by their sim clock.
    await page.evaluate(() => {
      const steady = (simT) => ({
        format: 'seg-plant-snapshot', version: 1, layoutHash: 0, catalogHash: '', backend: 'js',
        focus: 'seg', view: window.multiVisualizer.currentView, t: simT, seed: null, config: {},
        operator: {
          status: 'operational', isRunning: true, targetDrive: 1, magneticFieldStrength: 1, loadResistance: 100,
          totalEnergy: 0, efficiency: 90, displayRpm: 3000, displayField: 0.7,
          physics: { segOmega: 1, corona: 1, energyLevel: 1, magneticFieldStrength: 1 }
        },
        devices: {}
      });
      const row = (t) => ({
        time_s: t, frame_id: t, view: 'seg', mode: 'seg', status: 'operational',
        rpm_inner: 3000, seg_omega: 1, corona: 1, voltage_v: 100, current_a: 1, power_w: 100,
        field_sim_t: 0.7, energy_density_j_m3: 2e5, drive: 1, excitation_pct: 100, temperature_c: 30,
        efficiency_pct: 90, particle_flux: 20, load_ohm: 100, hw_connected: 0,
        hw_connection_state: 'disconnected', phase_error_deg: '', rpm_error: '', voltage_error_v: '',
        current_error_a: '', energy_residual_w: '', energy_coupled: 0
      });
      window.applyReplayFile({
        replayVersion: 1, createdAt: new Date().toISOString(), seed: null,
        segLayoutPreset: 'searl', heronLayoutPreset: 'classic', renderer: 'webgl2',
        speedCurve: [{ t: 10, drive: 1, simRate: 1 }, { t: 12, drive: 1, simRate: 1 }],
        config: { loadOhm: 100, magneticFieldStrength: 1, sampleHz: 1 },
        samples: [row(10), row(11), row(12)],
        keyframes: [{ t: 10, snapshot: steady(50_000) }, { t: 11, snapshot: steady(100_000) }]
      });
      window.replayPlayer.pause();
      window.replayPlayer.seek(1.5);
    });
    await waitForEval(page, () => window.segOperator?.replayMode === true, { timeout: 60_000 });
    await expect(page.locator('#replayTakeOverBtn')).toBeEnabled();

    // DOM click: a locator click waits on frames, which SwiftShader starves.
    await page.evaluate(() => document.getElementById('replayTakeOverBtn').click());
    // The click lazy-loads the snapshot chunk; slow in dev mode on SwiftShader.
    await expect(page.locator('#replayStatus')).toHaveText(/Took over from the t = 11\.00 s keyframe/, { timeout: 120_000 });

    const after = await page.evaluate(() => {
      window.__takeOverT = window.telemetryHub.getSimTimeS();
      return {
        replayMode: window.segOperator.replayMode,
        hubReplay: window.telemetryHub.isReplayMode(),
        loaded: window.replayPlayer.state.loaded,
        simT: window.__takeOverT
      };
    });
    expect(after.replayMode).toBe(false);
    expect(after.hubReplay).toBe(false);
    expect(after.loaded).toBe(false);
    // The t = 11 keyframe's clock, not the t = 10 one (50 000 s) or the boot clock.
    expect(after.simT).toBeGreaterThanOrEqual(100_000);

    // Live from there: the plant steps on and holds the steady point.
    await waitForEval(page, () => window.telemetryHub.getSimTimeS() > window.__takeOverT + 0.5, { timeout: 120_000 });
    const live = await page.evaluate(() => ({
      status: window.segOperator.status,
      running: window.segOperator.isRunning,
      segOmega: window.segOperator.physics.segOmega
    }));
    expect(live.status).toBe('operational');
    expect(live.running).toBe(true);
    expect(Math.abs(live.segOmega - 1)).toBeLessThan(1e-3);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('Embed postMessage protocol (#224 §5)', () => {
  // One lab boot: a parent page on an allowed origin frames the lab, and a
  // sibling frame on another origin tries the same requests. Both parents are
  // served by page.route, so no second server is needed, and are https — a
  // lab framed by a plain http page is no secure context and cannot boot
  // (EMBED.md). Chrome's Local
  // Network Access checks would block a "public" (routed) page from framing
  // the localhost dev server — a deployed lab is public — so this test runs
  // in its own browser with them off (launchOptions cannot vary per group).
  test('an allowed parent gets hello / loadConfig replies; another origin gets nothing', async ({ playwright, baseURL }) => {
    // A full lab boot plus the lazy embed / lab-file chunks inside a frame;
    // under SwiftShader on a loaded VM each step can take minutes.
    test.setTimeout(900_000);
    const browser = await playwright.chromium.launch({
      args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests']
    });
    try {
      await embedProtocolFlow(await browser.newPage({ viewport: { width: 1280, height: 800 } }), baseURL);
    } finally {
      await browser.close();
    }
  });
});

/** @param {import('@playwright/test').Page} page @param {string | undefined} baseURL */
async function embedProtocolFlow(page, baseURL) {
  const { pageErrors } = trackPageErrors(page);
  const labUrl = new URL('/?renderer=webgl2&embed=1&embedOrigins=https://school.example', baseURL).href;
  const labOrigin = new URL(labUrl).origin;
  const recorder = `<script>
    window.__got = [];
    window.addEventListener('message', (ev) => window.__got.push({ origin: ev.origin, data: ev.data }));
  </script>`;
  await page.route('https://school.example/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>parent</title>${recorder}
      <iframe id="lab" src="${labUrl}" style="width:640px;height:400px"></iframe>
      <iframe id="evil" src="https://evil.example/frame.html" style="width:10px;height:10px"></iframe>`
  }));
  await page.route('https://evil.example/**', (route) => route.fulfill({
    contentType: 'text/html', body: `<!doctype html><title>evil</title>${recorder}`
  }));

  await page.goto('https://school.example/parent.html', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await waitForEval(page, () => window.__got.some((m) => m.data?.type === 'lab:ready'), { timeout: 330_000, intervalMs: 500 });

  const replies = await page.evaluate(async (target) => {
    const lab = document.getElementById('lab').contentWindow;
    const wait = (id) => new Promise((resolve) => {
      const t0 = Date.now();
      (function poll() {
        const hit = window.__got.find((m) => m.data?.requestId === id);
        if (hit || Date.now() - t0 > 300_000) resolve(hit ?? null);
        else setTimeout(poll, 100);
      })();
    });
    lab.postMessage({ type: 'lab:hello', requestId: 'h1' }, target);
    lab.postMessage({ type: 'lab:loadConfig', requestId: 'c1', config: { mode: 'hall', bogus: 1 } }, target);
    lab.postMessage({ type: 'lab:subscribe', requestId: 'bad', keys: ['document.cookie'] }, target);
    return { hello: await wait('h1'), load: await wait('c1'), bad: await wait('bad') };
  }, labOrigin);
  expect(replies.hello?.origin).toBe(labOrigin);
  expect(replies.hello?.data).toMatchObject({ type: 'lab:hello:result', ok: true, protocol: 1, disclaimer: 'Simulated, not metrology' });
  expect(replies.hello?.data.capabilities).toEqual(expect.arrayContaining(['lab:loadConfig', 'lab:subscribe']));
  expect(replies.load?.data).toMatchObject({ type: 'lab:loadConfig:result', ok: true, requestId: 'c1' });
  expect(replies.load?.data.result.applied).toEqual(['mode']);
  expect(replies.load?.data.result.ignored).toEqual(['bogus']);
  expect(replies.bad?.data).toMatchObject({ type: 'lab:error', ok: false, requestId: 'bad' });

  const lab = page.frame({ url: /embed=1/ });
  expect(lab).not.toBeNull();
  await waitForEval(lab, () => window.multiVisualizer?.currentView === 'hall', { timeout: 120_000 });
  const chrome = await lab.evaluate(() => ({
    embed: document.documentElement.hasAttribute('data-lab-embed'),
    header: getComputedStyle(document.getElementById('header')).display,
    left: getComputedStyle(document.getElementById('left-panel')).display,
    badge: document.getElementById('lab-embed-badge')?.textContent ?? null
  }));
  expect(chrome).toEqual({ embed: true, header: 'none', left: 'none', badge: 'Simulated, not metrology' });

  // The sibling frame on https://evil.example can reach the lab's window
  // but not its protocol. A ping from the parent, sent after, proves the
  // lab already processed (and dropped) the evil messages.
  const evil = page.frame({ url: /evil\.example/ });
  expect(evil).not.toBeNull();
  await evil.evaluate((target) => {
    const lab = window.parent.frames[0];
    lab.postMessage({ type: 'lab:hello', requestId: 'e1' }, target);
    lab.postMessage({ type: 'lab:loadConfig', requestId: 'e2', config: { mode: 'transformer' } }, target);
  }, labOrigin);
  const ping = await page.evaluate(async (target) => {
    document.getElementById('lab').contentWindow.postMessage({ type: 'lab:ping', requestId: 'p1' }, target);
    const t0 = Date.now();
    while (Date.now() - t0 < 180_000) {
      const hit = window.__got.find((m) => m.data?.requestId === 'p1');
      if (hit) return hit.data;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }, labOrigin);
  expect(ping).toMatchObject({ type: 'lab:ping:result', ok: true });
  expect(ping.status.view).toBe('hall');
  const evilGot = await evil.evaluate(() => window.__got.filter((m) => typeof m.data?.type === 'string' && m.data.type.startsWith('lab:')));
  expect(evilGot).toEqual([]);
  expect(await lab.evaluate(() => window.multiVisualizer?.currentView)).toBe('hall');
  expect(pageErrors).toEqual([]);
}
