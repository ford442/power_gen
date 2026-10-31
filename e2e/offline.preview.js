// @ts-check
/**
 * Offline PWA (#224 §5, docs/CLASSROOM.md) against `vite preview` of a real
 * build — run with `npm run test:e2e:offline` (playwright.preview.config.js).
 *
 * 1. First visit registers sw.js, precaches exactly its list, shows no update
 *    toast; offline + reload still boots `?renderer=webgl2` from the cache.
 * 2. A redeploy (sw.js rewritten on disk) installs and *waits* behind the
 *    "Update available" toast; nothing reloads until Reload is clicked, which
 *    activates the new cache and drops the old one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { gotoWebGL2, trackPageErrors, waitForEval } from './helpers.js';

const SW_PATH = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist', 'sw.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until this page is controlled by an activated worker. */
async function waitForController(page) {
  await waitForEval(page, async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg?.active?.state === 'activated' && !!navigator.serviceWorker.controller;
  }, { timeout: 180_000 });
}

/** Precache list from the served sw.js vs. what the cache holds. */
function cacheState(page) {
  return page.evaluate(async () => {
    const text = await (await fetch('./sw.js', { cache: 'no-store' })).text();
    const urls = JSON.parse(/const PRECACHE_URLS = (\[[\s\S]*?\]);/.exec(text)?.[1] ?? '[]');
    const names = (await caches.keys()).filter((k) => k.startsWith('seg-lab:'));
    const cached = names.length === 1
      ? (await (await caches.open(names[0])).keys()).map((r) => new URL(r.url).pathname.replace(/^\//, ''))
      : [];
    return { urls, names, cached };
  });
}

test('first visit precaches the build; offline reload still boots WebGL2', async ({ page, context }) => {
  const { pageErrors } = trackPageErrors(page);
  /** @type {string[]} */
  const consoleErrors = [];
  page.on('console', (m) => {
    // The one known noise: headless Chrome's favicon probe (404 online, fails offline).
    if (m.type() === 'error' && !/favicon/.test(m.location().url ?? '')) consoleErrors.push(m.text());
  });

  await gotoWebGL2(page);
  await waitForController(page);
  await waitForEval(page, async () => {
    const names = (await caches.keys()).filter((k) => k.startsWith('seg-lab:'));
    return names.length === 1;
  }, { timeout: 120_000 });

  const state = await cacheState(page);
  expect(state.names).toHaveLength(1);
  expect(state.names[0]).toMatch(/^seg-lab:\/:[0-9a-f]{16}$/);
  expect([...state.cached].sort()).toEqual([...state.urls].sort());
  for (const must of ['index.html', 'wasm/sim_core.js', 'wasm/sim_core.wasm', 'manifest.webmanifest',
    'icons/icon-192.png', 'assets/seg/stand.glb']) {
    expect(state.urls, `precache list misses ${must}`).toContain(must);
  }
  expect(state.urls.some((u) => /^assets\/index-[\w-]+\.js$/.test(u)), 'entry chunk not precached').toBe(true);
  expect(state.urls.some((u) => /^assets\/recorder-[\w-]+\.js$/.test(u)), 'lazy recorder chunk not precached').toBe(true);
  expect(await page.evaluate(() => !!document.getElementById('pwaUpdateToast')), 'toast on first install').toBe(false);

  // Chrome's own installability verdict (manifest + icons + worker).
  const cdp = await context.newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  expect(installabilityErrors, JSON.stringify(installabilityErrors)).toEqual([]);

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitForEval(page, () => window.currentRenderer === 'webgl2' && !!document.getElementById('gpuCanvas'),
      { timeout: 180_000 });
    const offline = await page.evaluate(async () => ({
      controlled: !!navigator.serviceWorker.controller,
      online: navigator.onLine,
      wasmHead: (await fetch('./wasm/sim_core.wasm', { method: 'HEAD' })).status,
      manifest: (await fetch('./manifest.webmanifest')).status
    }));
    expect(offline).toEqual({ controlled: true, online: false, wasmHead: 200, manifest: 200 });
    // The lazy classroom chunk (and its recorder hook) loads from the cache too.
    await waitForEval(page, () => typeof window.recordBench === 'function', { timeout: 120_000 });
  } finally {
    await context.setOffline(false);
  }

  expect(pageErrors, `uncaught errors: ${pageErrors.join('; ')}`).toEqual([]);
  expect(consoleErrors, `console errors: ${consoleErrors.join('; ')}`).toEqual([]);
});

test('a redeploy waits behind "Update available" until Reload is clicked', async ({ page }) => {
  // Two full boots plus a background precache: slow on a starved CI box.
  test.setTimeout(900_000);
  await gotoWebGL2(page);
  await waitForController(page);
  const before = (await cacheState(page)).names;
  expect(before).toHaveLength(1);

  const original = readFileSync(SW_PATH, 'utf8');
  try {
    // A new deploy, as far as the browser can tell: same assets, new version.
    writeFileSync(SW_PATH, original.replace(/const PRECACHE_VERSION = "([0-9a-f]+)";/, 'const PRECACHE_VERSION = "$1-next";'));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update(); });

    await waitForEval(page, () => !!document.getElementById('pwaUpdateToast'), { timeout: 180_000 });
    const waiting = await page.evaluate(async () => {
      window.__beforeUpdate = true;
      const reg = await navigator.serviceWorker.getRegistration();
      return { waiting: !!reg?.waiting, text: document.getElementById('pwaUpdateToast')?.textContent };
    });
    expect(waiting.waiting).toBe(true);
    expect(waiting.text).toContain('Update available');

    // Never mid-lesson: nothing reloads or swaps caches on its own.
    await sleep(5_000);
    expect(await page.evaluate(() => window.__beforeUpdate)).toBe(true);
    expect((await cacheState(page)).names.some((n) => n.endsWith('-next'))).toBe(true); // installed alongside…
    expect((await page.evaluate(() => caches.keys())).includes(before[0])).toBe(true); // …old one still live

    await page.evaluate(() => /** @type {HTMLButtonElement} */ (document.getElementById('pwaUpdateReload')).click());
    // A fresh document (the flag is gone) controlled by the new worker; test 1
    // already proves a cached boot reaches WebGL2.
    await waitForEval(page, () => window.__beforeUpdate === undefined && !!navigator.serviceWorker.controller,
      { timeout: 180_000 });
    await waitForController(page);
    const after = (await page.evaluate(() => caches.keys())).filter((k) => k.startsWith('seg-lab:'));
    expect(after).toEqual([`${before[0]}-next`]);
  } finally {
    writeFileSync(SW_PATH, original);
  }
});
