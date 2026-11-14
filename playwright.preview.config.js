import { defineConfig, devices } from '@playwright/test';

/**
 * Offline PWA e2e (#224 §5, docs/CLASSROOM.md): the service worker exists only
 * in a production build, so these specs run against `vite preview` of a fresh
 * `build:site`, on their own port, never a dev server. `npm run test:e2e:offline`.
 *
 * Specs are `e2e/*.preview.js`, which the default config's `*.spec.js` match
 * never picks up (and vice versa).
 */
const PORT = 4183;

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.preview\.js$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 480_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Desktop Chrome'],
    viewport: { width: 800, height: 500 },
    serviceWorkers: 'allow',
    trace: 'on-first-retry',
    actionTimeout: 60_000,
    navigationTimeout: 120_000,
  },
  webServer: {
    command: `npm run build:site && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    // Always a fresh build: the precache list must match what is served.
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
