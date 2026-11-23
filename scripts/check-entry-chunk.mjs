#!/usr/bin/env node
/**
 * check-entry-chunk.mjs — the lazy lab features stay out of the entry chunk
 * (#239 acceptance: "the entry chunk does not grow by uPlot or the experiment
 * UI"; docs/ANALYSIS.md, docs/EXPERIMENTS.md, docs/CLASSROOM.md).
 *
 * Builds the site (`vite build`, no Emscripten) into a temp directory, walks
 * the entry's static import closure in `.vite/manifest.json`, and reads which
 * source modules landed in each of those chunks from their (hidden) source
 * maps — exact module membership, not a text grep of minified output. Fails
 * when a module that must load on demand is in that closure: uPlot, the QR
 * library, the analysis panel and spectrum chore, the experiment interpreter /
 * runners / panel, plant snapshots, the classroom recorder and PWA shell, the
 * share dialog / .lab.json loader, the embed endpoint and the Circuit Lab
 * (host and wiring view). Prints the
 * closure's size.
 *
 * The same walk from the WebGPU chunk (`multi-device-visualizer.ts`, itself
 * loaded on demand): the liquid solver, its boundary bake and its shaders
 * must stay in the chunk the Heron bench fetches on first focus (ADR-0022).
 *
 * Usage: node scripts/check-entry-chunk.mjs [--dist <built dir>]   (exit 1 on failure)
 *   --dist   check an existing `npm run build:site` output instead of building.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Lazy-only modules, by path prefix from the repo root (a trailing `/` is a
 * whole directory). `allow` lists the entry-side hooks a lazy feature keeps
 * there on purpose (button, `window.*` stub, run store).
 */
const LAZY = [
  { prefix: 'node_modules/uplot/', why: 'uPlot — analysis panel, dynamic import() on first open' },
  { prefix: 'node_modules/qrcode-generator/', why: 'QR code — share dialog, lazy' },
  {
    prefix: 'src/analysis/',
    allow: ['src/analysis/entry.ts', 'src/analysis/run-store.ts', 'src/analysis/run-types.ts'],
    why: 'analysis panel (only the button and the run store are entry)'
  },
  { prefix: 'src/gpu-chores/fft', why: 'spectrum chore — not in the gpu-chores barrel' },
  { prefix: 'src/experiments/', why: 'experiment interpreter, runners, panel, reference files' },
  { prefix: 'src/session/lab-snapshot.ts', why: 'plant snapshots — window.lab loads it on first use' },
  { prefix: 'src/session/plant-worker-snapshot.ts', why: 'plant snapshot worker calls' },
  { prefix: 'src/classroom/', why: 'classroom shell (recorder, PWA register) — main.ts imports it lazily' },
  { prefix: 'src/config/share-dialog.ts', why: 'share dialog' },
  { prefix: 'src/config/lab-file.ts', why: '.lab.json import / export' },
  { prefix: 'src/embed/', why: 'embed endpoint / teacher console — installed only under ?embed=1 / ?teacher=1' },
  { prefix: 'src/circuit/', why: 'Circuit Lab host, netlist compiler, ports, SPICE — loaded by ?circuit= / the Circuit button (#256)' },
  { prefix: 'src/circuit-ui/', why: 'Circuit Lab wiring view, schematic, scope' }
];

/** Lazy-only from the WebGPU chunk: loaded by the bench that needs them. */
const WEBGPU_ROOT = 'multi-device-visualizer.ts';
const WEBGPU_LAZY = [
  { prefix: 'src/fluids/', why: 'liquid solver (MLS-MPM) — heron-liquid-pass.ts imports its runtime on first Heron focus' },
  { prefix: 'src/visualizer/heron-liquid-runtime.ts', why: 'liquid pass runtime — dynamic import()' },
  { prefix: 'src/shaders/passes/mpm-', why: 'liquid solver shaders — travel with the runtime' },
  { prefix: 'src/visualizer/fluid-surface-pass.ts', why: 'liquid surface pass — part of the liquid runtime' },
  { prefix: 'src/pipeline-layout/factories/fluid-surface-pipelines.ts', why: 'liquid surface pipelines — built by the surface pass, not a cache method' },
  { prefix: 'src/shaders/passes/fluid-', why: 'liquid surface shaders — travel with the runtime' }
];

function violation(mod, rules = LAZY) {
  for (const rule of rules) {
    if (!mod.startsWith(rule.prefix)) continue;
    if (rule.allow?.includes(mod)) return null;
    return rule;
  }
  return null;
}

async function buildSite() {
  const { build } = await import('vite');
  const out = mkdtempSync(join(tmpdir(), 'seg-entry-chunk-'));
  await build({
    configFile: join(ROOT, 'vite.config.js'),
    logLevel: 'error',
    build: { outDir: out, emptyOutDir: true }
  });
  return out;
}

const distArg = process.argv.indexOf('--dist');
const dist = distArg > 0 ? join(process.cwd(), process.argv[distArg + 1]) : await buildSite();
const ownsDist = distArg < 0;

try {
  const manifestPath = join(dist, '.vite', 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`no ${relative(ROOT, manifestPath)} — vite.config.js must keep build.manifest`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
  if (!entryKey) throw new Error('manifest has no entry');

  /** Static import closure of a manifest key: its chunks, their source modules, their size. */
  const walk = (rootKey) => {
    const closure = new Set();
    const stack = [rootKey];
    while (stack.length) {
      const k = stack.pop();
      if (closure.has(k)) continue;
      closure.add(k);
      for (const i of manifest[k].imports ?? []) stack.push(i);
    }
    let bytes = 0;
    let gz = 0;
    const modules = new Set();
    const unmapped = [];
    for (const k of closure) {
      const file = join(dist, manifest[k].file);
      const text = readFileSync(file);
      bytes += statSync(file).size;
      gz += gzipSync(text).length;
      const mapFile = `${file}.map`;
      if (!existsSync(mapFile)) {
        // Bundler runtime helpers (preload helper, rolldown runtime) carry no map.
        unmapped.push(manifest[k].file);
        continue;
      }
      const map = JSON.parse(readFileSync(mapFile, 'utf8'));
      for (const src of map.sources ?? []) {
        const abs = normalize(join(dirname(file), src));
        const rel = abs.includes('node_modules/') ? abs.slice(abs.indexOf('node_modules/')) : relative(ROOT, abs);
        modules.add(rel.split('?')[0]);
      }
    }
    return { closure, modules, unmapped, bytes, gz };
  };

  // What the browser fetches before main.ts runs.
  const { closure, modules, unmapped, bytes, gz } = walk(entryKey);

  const bad = [...modules].map((m) => [m, violation(m)]).filter(([, r]) => r);
  const appModules = [...modules].filter((m) => m.startsWith('src/')).length;
  if (unmapped.some((f) => !/preload-helper|rolldown-runtime/.test(f))) {
    bad.push([`(no source map) ${unmapped.join(', ')}`, { why: 'an entry chunk without a map cannot be checked' }]);
  }
  if (!appModules) bad.push(['(no src/ modules found)', { why: 'source maps did not resolve — vite.config.js must keep build.sourcemap' }]);

  // What the WebGPU renderer brings with it.
  const webgpuKey = Object.keys(manifest).find((k) => k.endsWith(WEBGPU_ROOT));
  const badWebgpu = [];
  if (!webgpuKey) {
    badWebgpu.push([`(no ${WEBGPU_ROOT} chunk in the manifest)`, { why: 'the WebGPU renderer must stay its own chunk' }]);
  } else {
    const gpu = walk(webgpuKey);
    for (const m of gpu.modules) {
      const rule = violation(m, WEBGPU_LAZY);
      if (rule) badWebgpu.push([m, rule]);
    }
    if (![...gpu.modules].some((m) => m.startsWith('src/visualizer/'))) {
      badWebgpu.push(['(no src/visualizer/ modules found)', { why: 'source maps did not resolve for the WebGPU chunk' }]);
    }
  }
  for (const [m, r] of badWebgpu) console.error(`  FAIL: ${m} is in the WebGPU chunk — ${r.why}`);
  if (badWebgpu.length) process.exitCode = 1;

  if (bad.length) {
    for (const [m, r] of bad) console.error(`  FAIL: ${m} is in the entry chunk — ${r.why}`);
    console.error(`[entry-chunk] ${bad.length} lazy module(s) leaked into the entry closure`);
    process.exitCode = 1;
  } else if (badWebgpu.length) {
    console.error(`[entry-chunk] ${badWebgpu.length} lazy module(s) leaked into the WebGPU chunk`);
  } else {
    console.log(`[entry-chunk] OK — entry closure ${closure.size} chunks, ${modules.size} modules (${appModules} from src/), `
      + `${(bytes / 1024).toFixed(1)} kB (${(gz / 1024).toFixed(1)} kB gzip); `
      + `${LAZY.length} lazy features stay on demand; the WebGPU chunk holds none of its ${WEBGPU_LAZY.length} lazy features`);
  }
} finally {
  if (ownsDist) rmSync(dist, { recursive: true, force: true });
}
