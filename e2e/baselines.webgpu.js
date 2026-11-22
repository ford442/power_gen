// @ts-check
/**
 * Image baselines (#258 §5, docs/WEBGPU.md → Image baselines).
 *
 * Six fixed views, captured with `window.captureCanvasFrame()` on a frozen
 * scene (`?seed=1`, `multiVisualizer.frozenTime`, pinned `low` tier) and
 * compared with pixelmatch against PNGs committed under
 * `e2e/baselines/<renderer>-swiftshader/`. The same six views are captured on
 * WebGL2 and compared with the WebGPU frame — the parity numbers quoted in
 * docs/WEBGL2.md.
 *
 * REPORT-ONLY for now: a view over its threshold is listed in the report
 * (test-results/webgpu-baselines/report.md, uploaded by CI with the actual
 * and diff PNGs) and annotated on the test, but does not fail it.
 * `BASELINE_GATE=1` makes it fail — that is the switch to flip once the
 * baselines have been stable on CI for two weeks. A baseline that cannot be
 * captured at all (boot failure, wrong view) fails either way.
 *
 * `npm run e2e:update-baselines` rewrites the committed PNGs from this run.
 * A baseline change needs the before / after image in the PR (CLAUDE.md).
 */
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { gotoWebGL2 } from './helpers.js';
import {
  bootWebgpu, captureFramePng, gpuErrors, installDrawProbe, pinQualityTier, renderFrames, suppressDraws, waitForEval
} from './webgpu-helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BASELINE_DIR = join(HERE, 'baselines');
const OUT_DIR = join(ROOT, 'test-results', 'webgpu-baselines');
const UPDATE = process.env.UPDATE_BASELINES === '1';
const GATE = process.env.BASELINE_GATE === '1';

/** Scene time the capture is frozen at, seconds: past every start-up ramp. */
const FROZEN_TIME = 8;
/** pixelmatch per-pixel colour threshold (0..1, YIQ distance). */
const PIXEL_THRESHOLD = 0.1;

/**
 * `maxDiff` is the share of pixels allowed to differ from the baseline.
 * Tight where the frame is meshes and sky; looser where additive particles
 * and bloom smear sub-pixel differences over many pixels.
 */
const VIEWS = [
  { name: 'seg-studio', mode: 'seg', look: 'studio', maxDiff: 0.01 },
  { name: 'seg-lab', mode: 'seg', look: 'lab', maxDiff: 0.01 },
  { name: 'seg-drama', mode: 'seg', look: 'drama', maxDiff: 0.01 },
  { name: 'overview', mode: 'overview', look: 'studio', maxDiff: 0.02 },
  { name: 'transformer', mode: 'transformer', look: 'studio', maxDiff: 0.01 },
  { name: 'heron', mode: 'heron', look: 'studio', maxDiff: 0.01 }
];

/**
 * Additive particle billboards, both sample counts. Left out of the baselines
 * (the issue's `particles=0`): on SwiftShader they blanket the frame.
 */
const PARTICLE_PIPELINES = /^particlePipeline/;

/** Fixed seed; TAA off (its jitter index is a frame counter, not scene time). */
const queryFor = (view) => `seed=1&taa=0&look=${view.look}${view.mode === 'overview' ? '' : `&mode=${view.mode}`}`;

function decode(buffer) {
  return PNG.sync.read(buffer);
}

/** Share of pixels that differ, plus a diff image; null when the sizes differ. */
function compare(a, b) {
  if (a.width !== b.width || a.height !== b.height) return null;
  const diff = new PNG({ width: a.width, height: a.height });
  const differing = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: PIXEL_THRESHOLD });
  return { ratio: differing / (a.width * a.height), differing, diff: PNG.sync.write(diff) };
}

/** Hold the scene still, wait for the camera, render a few frames, capture. */
async function captureView(page, renderer, view) {
  if (renderer === 'webgpu') {
    await installDrawProbe(page);
    await bootWebgpu(page, queryFor(view));
    await pinQualityTier(page, 'low');
    await suppressDraws(page, PARTICLE_PIPELINES);
  } else {
    await gotoWebGL2(page, queryFor(view));
    await page.evaluate(() => {
      const particles = /** @type {any} */ (window.multiVisualizer)?.particleRenderer;
      if (particles) particles.draw = () => {};
    });
  }
  // `?mode=` is applied after boot and starts a camera transition; the view
  // is ready when the camera has stopped moving for half a second.
  await page.evaluate((mode) => { /** @type {any} */ (window).__wantView = mode; }, view.mode);
  await waitForEval(page, () => {
    const w = /** @type {any} */ (window);
    const viz = w.multiVisualizer;
    const cam = viz?.cameraController?.camera;
    if (viz?.currentView !== w.__wantView || !cam || cam.transitionActive) { w.__camStill = null; return false; }
    const key = [...cam.position, ...cam.target].map((v) => v.toFixed(4)).join(',');
    if (w.__camStill?.key !== key) { w.__camStill = { key, since: performance.now() }; return false; }
    return performance.now() - w.__camStill.since > 500;
  }, { timeout: 240_000, intervalMs: 150 });

  await page.evaluate(({ r, t }) => {
    const viz = /** @type {any} */ (window.multiVisualizer);
    if (r === 'webgpu') {
      viz.frozenTime = t;
    } else {
      // WebGL2's own debug pause: dt = 0, and scene time is a plain field.
      viz.debug.paused = true;
      viz.time = t;
    }
  }, { r: renderer, t: FROZEN_TIME });

  if (renderer === 'webgpu') await renderFrames(page, 4);
  else await page.waitForTimeout(2500);

  const shot = await captureFramePng(page);
  expect(shot.renderer).toBe(renderer);
  expect(shot.view).toBe(view.mode);
  if (renderer === 'webgpu') expect((await gpuErrors(page))?.uncaptured, 'GPU errors while capturing').toBe(0);
  return shot;
}

function writeRow(row) {
  mkdirSync(join(OUT_DIR, 'rows'), { recursive: true });
  writeFileSync(join(OUT_DIR, 'rows', `${row.renderer}-${row.view}.json`), JSON.stringify(row, null, 2));
}

test.describe.configure({ mode: 'serial' });
// Bigger than the functional specs: the canvas is the viewport minus the side panels.
test.use({ viewport: { width: 1000, height: 640 } });

test.describe('image baselines (report-only)', () => {
  test.beforeAll(() => {
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
  });

  for (const renderer of /** @type {const} */ (['webgpu', 'webgl2'])) {
    for (const view of VIEWS) {
      test(`baseline ${renderer} · ${view.name}`, async ({ page }) => {
        const shot = await captureView(page, renderer, view);
        const dir = join(BASELINE_DIR, `${renderer}-swiftshader`);
        const baselinePath = join(dir, `${view.name}.png`);
        const outDir = join(OUT_DIR, renderer);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `${view.name}.actual.png`), shot.png);

        const actual = decode(shot.png);
        // A black or flat frame is a capture failure, not a look change.
        let lit = 0;
        for (let i = 0; i < actual.data.length; i += 4) {
          if (actual.data[i] + actual.data[i + 1] + actual.data[i + 2] > 24) lit++;
        }
        expect(lit / (actual.width * actual.height), 'share of non-black pixels').toBeGreaterThan(0.02);

        /** @type {Record<string, any>} */
        const row = { renderer, view: view.name, width: actual.width, height: actual.height, maxDiff: view.maxDiff, status: 'ok', ratio: null };
        if (UPDATE) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(baselinePath, shot.png);
          row.status = 'updated';
        } else if (!existsSync(baselinePath)) {
          row.status = 'no-baseline';
        } else {
          const result = compare(actual, decode(readFileSync(baselinePath)));
          if (!result) {
            row.status = 'size-changed';
          } else {
            row.ratio = result.ratio;
            if (result.differing) writeFileSync(join(outDir, `${view.name}.diff.png`), result.diff);
            if (result.ratio > view.maxDiff) row.status = 'over-threshold';
          }
        }
        writeRow(row);
        if (row.status !== 'ok' && row.status !== 'updated') {
          test.info().annotations.push({
            type: 'baseline',
            description: `${renderer}/${view.name}: ${row.status}${row.ratio == null ? '' : ` — ${(row.ratio * 100).toFixed(2)} % of pixels differ (limit ${(view.maxDiff * 100).toFixed(1)} %)`}`
          });
          if (GATE) expect(row.status, `baseline ${renderer}/${view.name}`).toBe('ok');
        }
      });
    }
  }

  test('baseline report: per-view diffs and WebGPU ↔ WebGL2 parity', async () => {
    const rowsDir = join(OUT_DIR, 'rows');
    const rows = existsSync(rowsDir) ? readdirSync(rowsDir).map((f) => JSON.parse(readFileSync(join(rowsDir, f), 'utf8'))) : [];
    expect(rows.length, 'captured views').toBeGreaterThan(0);

    // Parity: the two renderers' frames of the same frozen scene. Never a gate —
    // the renderers differ by design (docs/WEBGL2.md); this is the measurement.
    const parity = [];
    mkdirSync(join(OUT_DIR, 'parity'), { recursive: true });
    for (const view of VIEWS) {
      const files = ['webgpu', 'webgl2'].map((r) => join(OUT_DIR, r, `${view.name}.actual.png`));
      if (!files.every(existsSync)) continue;
      const [gpu, gl] = files.map((f) => decode(readFileSync(f)));
      const result = compare(gpu, gl);
      if (!result) {
        parity.push({ view: view.name, ratio: null, note: `sizes differ (${gpu.width}×${gpu.height} vs ${gl.width}×${gl.height})` });
        continue;
      }
      writeFileSync(join(OUT_DIR, 'parity', `${view.name}.diff.png`), result.diff);
      let sum = 0;
      for (let i = 0; i < gpu.data.length; i += 4) {
        sum += Math.abs(gpu.data[i] - gl.data[i]) + Math.abs(gpu.data[i + 1] - gl.data[i + 1]) + Math.abs(gpu.data[i + 2] - gl.data[i + 2]);
      }
      parity.push({ view: view.name, ratio: result.ratio, meanAbs: sum / (gpu.width * gpu.height * 3) });
    }

    const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(2)} %`);
    const order = (r) => `${r.renderer === 'webgpu' ? 0 : 1}${VIEWS.findIndex((v) => v.name === r.view)}`;
    rows.sort((a, b) => order(a).localeCompare(order(b)));
    const md = [
      `## Image baselines (${UPDATE ? 'updated' : GATE ? 'gating' : 'report-only'})`,
      '',
      '| Renderer | View | Size | Pixels differing | Limit | Status |',
      '|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.renderer} | ${r.view} | ${r.width}×${r.height} | ${pct(r.ratio)} | ${pct(r.maxDiff)} | ${r.status} |`),
      '',
      '### WebGPU ↔ WebGL2 parity (same frozen scene; not a gate)',
      '',
      '| View | Pixels differing | Mean abs. channel difference (0–255) |',
      '|---|---|---|',
      ...parity.map((p) => `| ${p.view} | ${p.note ?? pct(p.ratio)} | ${p.meanAbs == null ? '—' : p.meanAbs.toFixed(1)} |`),
      ''
    ].join('\n');
    writeFileSync(join(OUT_DIR, 'report.md'), md);
    writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify({ mode: UPDATE ? 'update' : GATE ? 'gate' : 'report', rows, parity }, null, 2));
    console.log(`\n${md}`);
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`, { flag: 'a' });
  });
});
