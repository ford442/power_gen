/**
 * Shared Playwright helpers for SEG WebGL2 agent-hook tests.
 */
import { inflateRawSync } from 'node:zlib';

/**
 * The fields of a share hash, whichever form it is in: `#lab=v1;k=v;…` as
 * written, or a `#lab2=` link decoded (docs/LAB_CONFIG.md: `z` + base64url of
 * raw-deflated JSON, or `j` + base64url of JSON; the fields are under `c`).
 * Decoded here, not by the app, so the test does not lean on what it tests.
 * The app rewrites a `#lab=v1` link as `#lab2=` a moment after boot, so a
 * test that reads `location.hash` can meet either.
 * @param {string} hash
 * @returns {Record<string, unknown>}
 */
export function shareHashFields(hash) {
  const v2 = hash.match(/#lab2=([zj])([A-Za-z0-9_-]+)/);
  if (v2) {
    const bytes = Buffer.from(v2[2], 'base64url');
    const json = (v2[1] === 'z' ? inflateRawSync(bytes) : bytes).toString('utf8');
    return JSON.parse(json).c ?? {};
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const part of hash.replace(/^#lab=/, '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** @typedef {{ pageErrors: string[] }} PageErrorTracker */

/**
 * Attach listeners for uncaught page errors.
 * @param {import('@playwright/test').Page} page
 * @returns {PageErrorTracker}
 */
export function trackPageErrors(page) {
  /** @type {string[]} */
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  return { pageErrors };
}

/**
 * Node-side sleep — does not require the page main thread (unlike page.waitForTimeout).
 * SwiftShader WebGL2 frames can block the main thread for seconds; Playwright's
 * waitForFunction / waitForTimeout then starve even when hooks are already set.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a page predicate via page.evaluate + Node timers.
 * Prefer this over page.waitForFunction on the WebGL2 path: SwiftShader
 * frames can block the main thread long enough that Playwright's in-page
 * polling starves even when the condition is already true.
 *
 * @param {import('@playwright/test').Page} page
 * @param {() => unknown} fn  Serialized into the page; must be self-contained.
 * @param {{ timeout?: number, intervalMs?: number }} [opts]
 */
export async function waitForEval(page, fn, opts = {}) {
  const timeout = opts.timeout ?? 30_000;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate(fn)) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  const detail = lastErr instanceof Error ? lastErr.message : '';
  throw new Error(`waitForEval timed out after ${timeout}ms${detail ? `: ${detail}` : ''}`);
}

/**
 * Navigate to the app with WebGL2 renderer and wait for agent hooks.
 * @param {import('@playwright/test').Page} page
 * @param {string} [extraQuery]
 */
export async function gotoWebGL2(page, extraQuery = '') {
  const query = extraQuery ? `&${extraQuery.replace(/^\?/, '')}` : '';
  const url = `/?renderer=webgl2${query}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    // domcontentloaded is enough — 'load' waits on optional WASM/assets and is
    // not required for renderer hooks.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    try {
      await waitForEval(page, () => window.currentRenderer === 'webgl2'
        && (typeof window.getRendererInfo === 'function'
          || typeof window.captureCanvasFrame === 'function'
          || window.multiVisualizer != null), { timeout: 45_000 });
      return;
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(1000);
    }
  }
}
