/**
 * test-harness.mjs — the one place unit tests turn TS sources into an
 * importable module. Every `scripts/tests/*.test.mjs` uses `bundleTs` instead
 * of repeating esbuild + mkdtemp + `import(data:…)` boilerplate.
 *
 *   import { bundleTs } from '../test-harness.mjs';
 *   const m = await bundleTs('src/devices/quanta/pulse-coil.ts');
 *   const n = await bundleTs({ contents: "export { a } from './src/a.ts';", sourcefile: 'entry.ts' });
 *
 * Bundles are written to `node_modules/.cache/seg-tests/<key>.mjs` and imported
 * by file URL, so relative `import.meta.url`, stack traces and `node:` builtins
 * (with `external`) all behave like a real file. A manifest next to each bundle
 * records the sha-256 of every file esbuild read; when none changed the bundle
 * is reused without running esbuild. Set SEG_TEST_NO_CACHE=1 to always rebuild.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = join(ROOT, 'node_modules/.cache/seg-tests');

/** Stub Vite's `?raw` shader-text imports so app-reaching graphs still bundle. */
export const viteRawStub = {
  name: 'vite-raw-stub',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: args.path, namespace: 'raw-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'raw-stub' }, () => ({ contents: 'export default "";', loader: 'js' }));
  }
};

const sha = (data) => createHash('sha256').update(data).digest('hex');

/** Stable JSON for the cache key: plugin objects reduce to name + optional cacheKey. */
function keyOf(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && typeof v.setup === 'function') return `plugin:${v.name}:${v.cacheKey ?? ''}`;
    if (v instanceof RegExp) return `re:${v.source}/${v.flags}`;
    if (typeof v === 'function') return `fn:${v.name}`;
    return v;
  });
}

function inputsUnchanged(manifest) {
  for (const [file, hash] of Object.entries(manifest.inputs)) {
    try {
      if (sha(readFileSync(file)) !== hash) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Bundle a TS/JS entry (repo-relative path, or `{ contents, sourcefile? }` resolved
 * from the repo root) and write it to the cache. Returns the bundle's file path.
 *
 * `options` are esbuild overrides (`plugins`, `define`, `external`, `platform`, …).
 * The defaults match what Vite does to app sources: ESM, `platform: 'neutral'`,
 * `.wgsl` / `.glsl` as text, `?raw` imports stubbed. `plugins` are appended
 * after the raw stub. A plugin whose output depends on its arguments should
 * carry a `cacheKey` string so two configurations do not share a bundle.
 */
export async function bundleTsFile(entry, options = {}) {
  const { plugins = [], ...rest } = options;
  const isStdin = typeof entry === 'object';
  const key = sha(keyOf({ entry, options }));
  const out = join(CACHE_DIR, `${key}.mjs`);
  const manifestPath = join(CACHE_DIR, `${key}.json`);

  if (!process.env.SEG_TEST_NO_CACHE && existsSync(out) && existsSync(manifestPath)) {
    try {
      if (inputsUnchanged(JSON.parse(readFileSync(manifestPath, 'utf8')))) return out;
    } catch { /* corrupt manifest: rebuild */ }
  }

  const result = await esbuild.build({
    ...(isStdin
      ? { stdin: { contents: entry.contents, resolveDir: entry.resolveDir ?? ROOT, sourcefile: entry.sourcefile ?? 'test-entry.ts', loader: entry.loader ?? 'ts' } }
      : { entryPoints: [isAbsolute(entry) ? entry : join(ROOT, entry)] }),
    absWorkingDir: ROOT, // metafile input paths are relative to this
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    mainFields: ['module', 'main'],
    write: false,
    metafile: true,
    logLevel: 'silent',
    loader: { '.wgsl': 'text', '.glsl': 'text' },
    ...rest,
    plugins: [viteRawStub, ...plugins]
  });

  const inputs = {};
  for (const rel of Object.keys(result.metafile.inputs)) {
    // Plugin namespaces (`raw-stub:…`, `<stdin>`) have no file to hash.
    const file = resolve(ROOT, rel);
    if (existsSync(file)) inputs[file] = sha(readFileSync(file));
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  // Write-then-rename: parallel test files may build the same key at once.
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, result.outputFiles[0].text);
  renameSync(tmp, out);
  writeFileSync(`${manifestPath}.${process.pid}.tmp`, JSON.stringify({ entry: isStdin ? entry.sourcefile ?? '<stdin>' : entry, inputs }));
  renameSync(`${manifestPath}.${process.pid}.tmp`, manifestPath);
  return out;
}

/** `bundleTsFile` + `import()`. Returns the module namespace. */
export async function bundleTs(entry, options = {}) {
  return import(pathToFileURL(await bundleTsFile(entry, options)).href);
}

/** `|a - b| <= tol` (absolute), for float comparisons in assertions. */
export function near(a, b, tol = 1e-9) {
  return Math.abs(a - b) <= tol;
}
