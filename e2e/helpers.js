/**
 * Shared Playwright helpers for SEG WebGL2 agent-hook tests.
 */

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
 * Navigate to the app with WebGL2 renderer and wait for agent hooks.
 * @param {import('@playwright/test').Page} page
 * @param {string} [extraQuery]
 */
export async function gotoWebGL2(page, extraQuery = '') {
  const query = extraQuery ? `&${extraQuery.replace(/^\?/, '')}` : '';
  const url = `/?renderer=webgl2${query}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const canvas = page.locator('#gpuCanvas');
    try {
      await canvas.waitFor({ state: 'attached', timeout: 15_000 });
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      await page.waitForTimeout(500);
    }
  }

  await page.waitForFunction(() =>
    window.currentRenderer === 'webgl2' && typeof window.getRendererInfo === 'function'
  );
}
