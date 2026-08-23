import { defineConfig, devices } from '@playwright/test';

/** @type {import('@playwright/test').PlaywrightTestConfig} */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  // Cold Vite transform of the TS graph on SwiftShader VMs can exceed 90s.
  timeout: 180_000,
  use: {
    baseURL: 'http://localhost:5173',
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    trace: 'on-first-retry',
    actionTimeout: 60_000,
    navigationTimeout: 90_000,
  },
  webServer: {
    command: 'npm run dev',
    // Hit the WebGL2 path so the first transform of main + webgl2 graph is warm
    // before tests call gotoWebGL2.
    url: 'http://localhost:5173/?renderer=webgl2',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
