#!/usr/bin/env node
/**
 * 700-line gate for hand-written source under src/** and cpp/src/**.
 *
 * A file past the line is a module asking to be split. Skipped:
 *   - any `generated/` directory (codegen output)
 *   - `src/public/**` (static assets), `src/wasm/sim-core/**` (Emscripten glue)
 *   - non-source extensions (json, md, images, …)
 *
 * ALLOWLIST pins a file that is over the line today at its current length so
 * it cannot grow; shrink the cap (or delete the row) when the file is split.
 * The gate also fails on a stale row so the list cannot rot.
 *
 * Usage: node scripts/check-file-size.mjs   (exit 1 on failure)
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const MAX_LINES = 700;
const ROOTS = ['src', 'cpp/src'];
const EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cpp', '.h', '.hpp', '.wgsl', '.glsl', '.css', '.html']);
const SKIP_DIRS = new Set(['generated', 'node_modules']);
const SKIP_PREFIXES = ['src/public/', 'src/wasm/sim-core/'];

/** path → max lines. Keep empty; a row here is debt with a ceiling. */
const ALLOWLIST = {};

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) yield* walk(full);
    } else if (ent.isFile()) {
      yield full;
    }
  }
}

const countLines = (text) => (text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

const failures = [];
let scanned = 0;
for (const r of ROOTS) {
  for (const full of walk(join(ROOT, r))) {
    const rel = relative(ROOT, full).split('\\').join('/');
    if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (!EXTENSIONS.has(extname(rel))) continue;
    scanned++;
    const lines = countLines(readFileSync(full, 'utf8'));
    const cap = ALLOWLIST[rel] ?? MAX_LINES;
    if (lines > cap) {
      failures.push(
        rel in ALLOWLIST
          ? `${rel}: ${lines} lines, allowlisted at ${cap} — it may only shrink`
          : `${rel}: ${lines} lines > ${MAX_LINES} — split it`
      );
    }
  }
}
for (const [rel, cap] of Object.entries(ALLOWLIST)) {
  const full = join(ROOT, rel);
  if (!existsSync(full)) {
    failures.push(`${rel}: allowlisted but gone — delete the ALLOWLIST row`);
  } else if (countLines(readFileSync(full, 'utf8')) <= MAX_LINES) {
    failures.push(`${rel}: now ≤ ${MAX_LINES} lines — delete the ALLOWLIST row (cap was ${cap})`);
  }
}

if (failures.length) {
  for (const f of failures) console.error('[file-size] FAIL', f);
  process.exit(1);
}
console.log(`[file-size] ${scanned} files ≤ ${MAX_LINES} lines (${Object.keys(ALLOWLIST).length} allowlisted)`);
