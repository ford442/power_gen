#!/usr/bin/env node
/**
 * check-bundle-budget.mjs — gzip budgets for the entry chunk and the two
 * renderer chunks (#258 §7). Budgets: config/bundle-budget.json.
 *
 * Reads `dist/.vite/manifest.json` (vite.config.js emits it for exactly this)
 * and gzips each budgeted chunk's file. A chunk is named by a source module
 * it must contain, so a rename of the hashed file does not matter, and a
 * budgeted module that vanished from the manifest is an error rather than a
 * silent pass. Also prints the entry's whole static-import closure — what
 * the browser fetches before main.ts runs — for context; the budget is on
 * the chunk files, which is what a regression moves.
 *
 * Usage: node scripts/check-bundle-budget.mjs [--dist <built dir>]   (exit 1 over budget)
 *   --dist   check an existing `npm run build:site` output instead of building.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_FILE = 'config/bundle-budget.json';

async function buildSite() {
  const { build } = await import('vite');
  const out = mkdtempSync(join(tmpdir(), 'seg-bundle-budget-'));
  await build({ configFile: join(ROOT, 'vite.config.js'), logLevel: 'error', build: { outDir: out, emptyOutDir: true } });
  return out;
}

/**
 * Sizes of the budgeted chunks. Pure given a manifest and a file reader —
 * scripts/tests/bundle-budget.test.mjs drives it with fixtures.
 * @returns {{ name: string, file: string | null, bytes: number, gzip: number, max: number, ok: boolean, problem?: string }[]}
 */
export function measureBudget(manifest, budget, readFile) {
  return Object.entries(budget.chunks).map(([name, spec]) => {
    const keys = Object.keys(manifest).filter((k) => k === spec.module || k.endsWith(`/${spec.module}`));
    const max = spec.maxGzipKB * 1000;
    if (keys.length !== 1) {
      return { name, file: null, bytes: 0, gzip: 0, max, ok: false, problem: `${keys.length} manifest entries match module "${spec.module}"` };
    }
    const file = manifest[keys[0]].file;
    const data = readFile(file);
    const gzip = gzipSync(data).length;
    return { name, file, bytes: data.length, gzip, max, ok: gzip <= max };
  });
}

/** Bytes (raw, gzip) of the entry's static import closure. */
export function entryClosure(manifest, readFile) {
  const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
  const seen = new Set();
  const stack = entryKey ? [entryKey] : [];
  let bytes = 0;
  let gzip = 0;
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k)) continue;
    seen.add(k);
    const data = readFile(manifest[k].file);
    bytes += data.length;
    gzip += gzipSync(data).length;
    for (const i of manifest[k].imports ?? []) stack.push(i);
  }
  return { chunks: seen.size, bytes, gzip };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const distArg = process.argv.indexOf('--dist');
  // resolve(): relative to the cwd, and an absolute --dist stays absolute.
  const dist = distArg > 0 ? resolve(process.argv[distArg + 1]) : await buildSite();
  try {
    const manifestPath = join(dist, '.vite', 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`no ${relative(ROOT, manifestPath)} — vite.config.js must keep build.manifest`);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const budget = JSON.parse(readFileSync(join(ROOT, BUDGET_FILE), 'utf8'));
    const readFile = (file) => readFileSync(join(dist, file));
    const kb = (n) => (n / 1000).toFixed(1).padStart(6);

    const rows = measureBudget(manifest, budget, readFile);
    console.log('  chunk     gzip kB   budget    used   raw kB  file');
    for (const r of rows) {
      if (r.problem) { console.error(`  FAIL: ${r.name} — ${r.problem}`); continue; }
      console.log(`  ${r.name.padEnd(8)} ${kb(r.gzip)}   ${kb(r.max)}  ${(100 * r.gzip / r.max).toFixed(0).padStart(4)} %  ${kb(r.bytes)}  ${r.file}${r.ok ? '' : '   ← OVER BUDGET'}`);
    }
    const closure = entryClosure(manifest, readFile);
    console.log(`  entry closure: ${closure.chunks} chunks, ${kb(closure.bytes).trim()} kB (${kb(closure.gzip).trim()} kB gzip) before main.ts runs`);

    const bad = rows.filter((r) => !r.ok);
    if (bad.length) {
      for (const r of bad.filter((b) => !b.problem)) {
        console.error(`  FAIL: ${r.name} chunk is ${kb(r.gzip).trim()} kB gzip, budget ${kb(r.max).trim()} kB (${BUDGET_FILE}). `
          + 'Move the new code behind a dynamic import(), or raise the budget and say why in the PR.');
      }
      process.exitCode = 1;
    } else {
      console.log(`[bundle-budget] OK — ${rows.map((r) => `${r.name} ${kb(r.gzip).trim()}/${kb(r.max).trim()}`).join(', ')} kB gzip`);
    }
  } finally {
    if (distArg < 0) rmSync(dist, { recursive: true, force: true });
  }
}
