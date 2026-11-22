import { defineConfig, devices } from '@playwright/test';

/**
 * WebGPU e2e (#258 §4–5, docs/WEBGPU.md → How the GPU is tested): the primary
 * renderer in a real browser. `npm run test:e2e:webgpu`.
 *
 * Headed Chromium on SwiftShader's Vulkan: headless Chromium gets no WebGPU
 * adapter on a GPU-less runner (the device is lost at the first present),
 * headed under a virtual display does. scripts/e2e-webgpu.mjs wraps the run in
 * `xvfb-run` when there is no display.
 *
 * Served from `vite preview` of a fresh `build:site`, on its own port — the
 * bundle Pages ships, and a page load costs seconds instead of the dev
 * server's cold transform of the whole WebGPU graph.
 *
 * Specs are `e2e/*.webgpu.js`; the default config's `*.spec.js` match never
 * picks them up (and vice versa).
 */
const PORT = 4184;

/** The flags that give headed Chromium a (software) WebGPU adapter. */
export const WEBGPU_ARGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-angle=swiftshader',
  '--ignore-gpu-blocklist'
];

export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.webgpu\.js$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  outputDir: 'test-results/webgpu',
  // One software-rendered frame can take seconds at the `high` tier.
  timeout: 600_000,
  projects: [
    {
      name: 'webgpu',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://localhost:${PORT}`,
        headless: false,
        // Small on purpose: SwiftShader's frame time scales with pixels.
        viewport: { width: 640, height: 400 },
        launchOptions: { args: WEBGPU_ARGS },
        // No trace / video: their screenshots stall a software-rendered page.
        trace: 'off',
        actionTimeout: 60_000,
        navigationTimeout: 120_000
      }
    }
  ],
  webServer: {
    command: `npm run build:site && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    // Always a fresh build: the specs test this tree, not a stale dist/.
    reuseExistingServer: false,
    timeout: 300_000
  }
});
