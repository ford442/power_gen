#!/usr/bin/env node
/**
 * e2e-webgpu.mjs — `npm run test:e2e:webgpu` / `npm run e2e:update-baselines`.
 *
 * Runs playwright.webgpu.config.js (headed Chromium, SwiftShader WebGPU).
 * Headed needs a display: with none (CI, a container) the run is wrapped in
 * `xvfb-run -a`. Extra arguments go to Playwright (`-g "device loss"`).
 *
 *   --update-baselines   rewrite e2e/baselines/** from this run instead of
 *                        comparing against it (docs/WEBGPU.md → Image baselines)
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const update = args.includes('--update-baselines');
const rest = args.filter((a) => a !== '--update-baselines');

const playwright = ['playwright', 'test', '-c', 'playwright.webgpu.config.js', ...(update ? ['-g', 'baseline'] : []), ...rest];
const needsDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
let cmd = 'npx';
let argv = playwright;
if (needsDisplay) {
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
  if (probe.error) {
    console.error('[e2e-webgpu] no display and no xvfb-run. Install it (apt-get install xvfb) or run under a desktop session.');
    process.exit(1);
  }
  cmd = 'xvfb-run';
  argv = ['-a', '--server-args=-screen 0 1600x1000x24', 'npx', ...playwright];
}
const r = spawnSync(cmd, argv, {
  stdio: 'inherit',
  env: { ...process.env, ...(update ? { UPDATE_BASELINES: '1' } : {}) },
  shell: process.platform === 'win32'
});
process.exit(r.status ?? 1);
